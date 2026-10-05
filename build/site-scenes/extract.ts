// Website scene data from the real app: routes (with maneuvers, lanes, stops) from a running Co-Driver
// server and the pieces of the map around them, so the animated scenes on the website show real places
// drawn exactly like the app draws them. Pretends to be the game plugin (port 25555) to put the car
// where each scene starts. Never run it while the game is running.
//
//   node build/site-scenes.mjs explore --from bakersfield --to fresno     list the maneuvers of a route
//   node build/site-scenes.mjs build                                       write site/scenes/*.json
//
// Needs a test server:  CODRIVER_HOME=test-home CODRIVER_PORT=8090 CODRIVER_NO_PLUGIN=1 node app/launcher.mjs
import { fromAtsCoordsToWgs84, fromWgs84ToAtsCoords } from '@truckermudgeon/map/projections';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

type LL = [number, number];
const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'build';
const arg = (n: string, d: string) => { const i = argv.indexOf('--' + n); return i > 0 ? argv[i + 1] : d; };
const SERVER = arg('server', 'http://127.0.0.1:8090');
const HOME = process.env.CODRIVER_HOME ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ATS Co-Driver');
const OUT = arg('out', path.resolve(import.meta.dirname, '..', '..', 'site', 'scenes'));

// ------------------------------------------------------------------ geometry helpers (map metres)
const K = Math.PI / 180;
const metres = (a: LL, b: LL) => { const dLat = (b[1] - a[1]) * K, dLng = (b[0] - a[0]) * K * Math.cos(((a[1] + b[1]) / 2) * K); return Math.sqrt(dLat * dLat + dLng * dLng) * 6371000; };
const bearingOf = (a: LL, b: LL) => { const y = Math.sin((b[0] - a[0]) * K) * Math.cos(b[1] * K), x = Math.cos(a[1] * K) * Math.sin(b[1] * K) - Math.sin(a[1] * K) * Math.cos(b[1] * K) * Math.cos((b[0] - a[0]) * K); return (Math.atan2(y, x) / K + 360) % 360; };
const cumOf = (line: LL[]) => { const c = [0]; for (let i = 1; i < line.length; i++) c.push(c[i - 1] + metres(line[i - 1], line[i])); return c; };
function pointAt(line: LL[], cum: number[], s: number): { p: LL; i: number } {
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const t = Math.max(0, Math.min(1, (s - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1])));
  return { p: [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t], i };
}
function nearestAlong(line: LL[], cum: number[], p: LL) {
  const kx = Math.cos(p[1] * K) * 111320, ky = 110540;
  let best = { along: 0, d: Infinity };
  for (let i = 0; i < line.length - 1; i++) {
    const ax = (line[i][0] - p[0]) * kx, ay = (line[i][1] - p[1]) * ky, bx = (line[i + 1][0] - p[0]) * kx, by = (line[i + 1][1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    const d = Math.hypot(ax + dx * t, ay + dy * t);
    if (d < best.d) best = { along: cum[i] + t * (cum[i + 1] - cum[i]), d };
  }
  return best;
}
// Douglas–Peucker in metres
function simplify(line: LL[], tol: number): LL[] {
  if (line.length < 3 || tol <= 0) return line;
  const lat0 = line[0][1] * K, kx = Math.cos(lat0) * 111320, ky = 110540;
  const keep = new Uint8Array(line.length); keep[0] = keep[line.length - 1] = 1;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = line[a][0] * kx, ay = line[a][1] * ky, dx = line[b][0] * kx - ax, dy = line[b][1] * ky - ay, len = Math.hypot(dx, dy) || 1;
    let far = -1, fd = tol;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((line[i][0] * kx - ax) * dy - (line[i][1] * ky - ay) * dx) / len; if (d > fd) { fd = d; far = i; } }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return line.filter((_, i) => keep[i]);
}
// closed ring: split at the point farthest from the start so neither half starts and ends in one place
function simplifyRing(ring: LL[], tol: number): LL[] {
  if (ring.length < 5 || tol <= 0) return ring;
  let far = 1, fd = -1;
  for (let i = 1; i < ring.length - 1; i++) { const d = metres(ring[0], ring[i]); if (d > fd) { fd = d; far = i; } }
  const a = simplify(ring.slice(0, far + 1), tol), b = simplify(ring.slice(far), tol);
  return [...a, ...b.slice(1)];
}
// the app's drawn route: lane jogs removed (Douglas–Peucker ~1 lane), corners rounded (2× Chaikin)
function smoothRoute(line: LL[]): LL[] {
  let pts = simplify(line, 90);
  for (let it = 0; it < 2 && pts.length > 2; it++) {
    const out: LL[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) { const p = pts[i], q = pts[i + 1]; out.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25], [p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]); }
    out.push(pts[pts.length - 1]); pts = out;
  }
  return pts;
}

// ------------------------------------------------------------------ the map (same file the server draws from)
type Feature = { properties: Record<string, any>; geometry: { type: string; coordinates: any } };
const gj = JSON.parse(fs.readFileSync(path.join(HOME, 'map', 'gen', 'usa-map.geojson'), 'utf8')) as { features: Feature[] };
const MAP_M_PER_GAME_M = (() => { const a = fromAtsCoordsToWgs84([0, 0]) as LL, b = fromAtsCoordsToWgs84([1000, 0]) as LL; return metres(a, b) / 1000; })();
const LANE_M = 4.5;
function roadWidthMapM(p: Record<string, any>) {   // same as the server's
  const l = Math.max(0, Number(p.leftLanes) || 0), r = Math.max(0, Number(p.rightLanes) || 0);
  const lanes = l + r || ({ freeway: 4, divided: 4, local: 2 } as Record<string, number>)[String(p.roadType)] || 2;
  return Math.round((lanes * LANE_M + Math.max(0, Number(p.offset) || 0) + 0.5 * ((Number(p.shoulderSpaceLeft) || 0) + (Number(p.shoulderSpaceRight) || 0))) * MAP_M_PER_GAME_M);
}
// bbox per feature, once
const fb = gj.features.map(f => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (c: any) => { if (typeof c[0] === 'number') { if (c[0] < minX) minX = c[0]; if (c[0] > maxX) maxX = c[0]; if (c[1] < minY) minY = c[1]; if (c[1] > maxY) maxY = c[1]; } else for (const x of c) walk(x); };
  if (f.geometry) walk(f.geometry.coordinates);
  return [minX, minY, maxX, maxY];
});
const ROAD_T: Record<string, number> = { local: 0, unknown: 0, divided: 1, freeway: 2 };

// Map pieces near the places a scene's camera passes (`path` sampled every ~100 m). Near = everything
// (areas, all roads, icons); far = freeways and highways only (they're what you see far ahead).
function excerpt(pathPts: LL[], o: { near: number; far: number; tol: number; digits: number }) {
  const samples: LL[] = [];
  for (let i = 0; i < pathPts.length; i++) {
    samples.push(pathPts[i]);
    if (i < pathPts.length - 1) { const n = Math.floor(metres(pathPts[i], pathPts[i + 1]) / 100); for (let k = 1; k < n; k++) samples.push([pathPts[i][0] + (pathPts[i + 1][0] - pathPts[i][0]) * k / n, pathPts[i][1] + (pathPts[i + 1][1] - pathPts[i][1]) * k / n]); }
  }
  const lat0 = samples[0][1] * K, kx = Math.cos(lat0) * 111320, ky = 110540;
  // grid of samples for quick nearest-distance lookups
  const CELL = 2000, grid = new Map<string, LL[]>();
  for (const s of samples) { const key = `${Math.floor(s[0] * kx / CELL)},${Math.floor(s[1] * ky / CELL)}`; (grid.get(key) ?? grid.set(key, []).get(key)!).push(s); }
  const distTo = (b: number[], limit: number) => {
    // distance from the path to the feature's bbox (0 if the path runs through it)
    const x0 = Math.floor((b[0] * kx - limit) / CELL), x1 = Math.floor((b[2] * kx + limit) / CELL), y0 = Math.floor((b[1] * ky - limit) / CELL), y1 = Math.floor((b[3] * ky + limit) / CELL);
    let best = Infinity;
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) for (const s of grid.get(`${gx},${gy}`) ?? []) {
      const dx = Math.max(b[0] - s[0], 0, s[0] - b[2]) * kx, dy = Math.max(b[1] - s[1], 0, s[1] - b[3]) * ky;
      const d = Math.hypot(dx, dy); if (d < best) best = d;
    }
    return best;
  };
  const r = (v: number) => +v.toFixed(o.digits);
  const flat = (pts: LL[]) => pts.flatMap(p => [r(p[0]), r(p[1])]);
  const out = { roads: [] as any[], areas: [] as any[], pois: [] as any[], exits: [] as any[], cities: [] as any[] };
  gj.features.forEach((f, i) => {
    const p = f.properties, t = p.type;
    if (p.hidden === true || p.secret === true || !f.geometry) return;
    if (t === 'city') { if (distTo(fb[i], 60000) < 60000) out.cities.push([p.name, p.scaleRank ?? 5, r(f.geometry.coordinates[0]), r(f.geometry.coordinates[1])]); return; }
    if (t === 'road') {
      const rt = ROAD_T[p.roadType] ?? 0, lim = rt === 2 ? o.far : rt === 1 ? (o.near + o.far) / 2 : o.near;
      if (distTo(fb[i], lim) > lim) return;
      const line = simplify(f.geometry.coordinates as LL[], o.tol);
      out.roads.push([rt, roadWidthMapM(p), flat(line)]);
      return;
    }
    if (t === 'mapArea' || t === 'prefab') {
      if (distTo(fb[i], o.near * 0.7) > o.near * 0.7) return;
      const ring = simplifyRing(f.geometry.coordinates[0] as LL[], o.tol);
      if (ring.length >= 4) out.areas.push([t === 'prefab' ? 1 : 0, p.color ?? 0, p.zIndex ?? 0, flat(ring)]);
      return;
    }
    if (t === 'poi' && ['facility', 'company', 'road'].includes(p.poiType)) {
      if (distTo(fb[i], o.near) > (p.poiType === 'road' ? o.far * 0.6 : o.near)) return;
      out.pois.push([p.poiType, p.sprite, p.poiName ?? '', r(f.geometry.coordinates[0]), r(f.geometry.coordinates[1])]);
      return;
    }
    if (t === 'exit') { if (distTo(fb[i], o.near) <= o.near) out.exits.push([p.name, r(f.geometry.coordinates[0]), r(f.geometry.coordinates[1])]); }
  });
  return out;
}

// speed cap (game m/s) along a route line from the roads under it: freeway 60 mph, highway 45, town 30
function speedCaps(line: LL[]) {
  const cand = gj.features.map((f, i) => ({ f, b: fb[i] })).filter(({ f }) => f.properties.type === 'road' && f.properties.hidden !== true);
  const [minX, minY, maxX, maxY] = line.reduce((a, p) => [Math.min(a[0], p[0]), Math.min(a[1], p[1]), Math.max(a[2], p[0]), Math.max(a[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
  const near = cand.filter(({ b }) => b[2] > minX - 0.01 && b[0] < maxX + 0.01 && b[3] > minY - 0.01 && b[1] < maxY + 0.01);
  return line.map(p => {
    let best = 0, bd = Infinity;
    for (const { f, b } of near) {
      if (p[0] < b[0] - 0.003 || p[0] > b[2] + 0.003 || p[1] < b[1] - 0.003 || p[1] > b[3] + 0.003) continue;
      const c = f.geometry.coordinates as LL[], cum = cumOf(c);
      const d = nearestAlong(c, cum, p).d;
      if (d < bd) { bd = d; best = ROAD_T[f.properties.roadType] ?? 0; }
    }
    return best === 2 ? 26.8 : best === 1 ? 20.1 : 13.4;
  });
}

// ------------------------------------------------------------------ exact action spots (pumps, garages, parking)
// Same as the server's: spawn / trigger points from the prefab descriptions, placed in the world.
// Loaded only when a recipe asks (reading the full map data takes a minute).
let spotCache: { x: number; y: number; kind: string }[] | null = null;
async function actionSpots(near: LL, radiusMap: number, kind?: string) {
  if (!spotCache) {
    const { readGraphAndMapData } = await import('../../src/packages/apis/navigation/infra/lookups/graph-and-map');
    const { fromDir } = await import('@truckermudgeon/io');
    const { toMapPosition } = await import('@truckermudgeon/map/prefabs');
    console.log('  loading prefab data for the action spots…');
    const { tsMapData } = readGraphAndMapData(fromDir(path.join(HOME, 'map', 'parser')), 'usa') as any;
    const companyPrefabs = new Set([...tsMapData.companies.values()].map((c: any) => c.prefabUid));
    spotCache = [];
    for (const pf of tsMapData.prefabs.values() as Iterable<any>) {
      const desc = tsMapData.prefabDescriptions.get(pf.token);
      if (!desc) continue;
      const add = (pt: { x: number; y: number }, k: string) => { try { const [x, y] = toMapPosition([pt.x, pt.y], pf, desc, tsMapData.nodes); spotCache!.push({ x, y, kind: k }); } catch { /* missing nodes */ } };
      for (const s of desc.spawnPoints ?? []) { if (s.type === 3) add(s, 'fuel'); else if (s.type === 4) add(s, 'service'); }
      for (const tp of desc.triggerPoints ?? []) if ((tp.action === 'hud_parking' || tp.action === 'parking_car') && !companyPrefabs.has(pf.uid)) add(tp, 'sleep');
    }
    console.log(`  ${spotCache.length} action spots`);
  }
  return spotCache.filter(s => !kind || s.kind === kind)
    .map(s => ({ kind: s.kind, ll: fromAtsCoordsToWgs84([s.x, s.y]) as LL }))
    .map(s => ({ ...s, d: metres(s.ll, near) }))
    .filter(s => s.d <= radiusMap).sort((a, b) => a.d - b.d);
}

// ------------------------------------------------------------------ fake game plugin
const portFree = (port: number) => new Promise<boolean>(r => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(port, '127.0.0.1'); });
if (!(await portFree(25555))) { console.error('Port 25555 is in use (game running?) — stop it first.'); process.exit(1); }
const truck = { lngLat: [-119.0187, 35.3733] as LL, bearing: 0, speed: 0, fuelPct: 80, rangeKm: 600, restMin: 600, job: null as null | Record<string, unknown> };
const wss = new WebSocketServer({ host: '127.0.0.1', port: 25555, path: '/ws' });
let connected: (() => void) | null = null;
const ready = new Promise<void>(r => (connected = r));
wss.on('connection', (ws: WebSocket) => {
  connected?.();
  const t = setInterval(() => {
    const [x, z] = fromWgs84ToAtsCoords(truck.lngLat) as LL;
    ws.send(JSON.stringify({
      game: 'ats (website scene extractor)', paused: false,
      ch: {
        'truck.world.placement': { pos: [x, 10, z], rot: [1 - truck.bearing / 360, 0, 0] },
        'truck.speed': truck.speed, 'truck.engine.rpm': 800, 'truck.displayed.gear': 0,
        'truck.fuel.amount': 70 * truck.fuelPct / 100, 'truck.fuel.range': truck.rangeKm, 'rest.stop': truck.restMin, 'game.time': 6 * 1440 + 15 * 60,
        'truck.engine.enabled': true, 'truck.electric.enabled': true,
        'truck.wear.engine': 0, 'truck.wear.cabin': 0, 'truck.wear.chassis': 0,
      },
      cfg: { truck: { 'fuel.capacity': 70, brand: 'ford', name: 'F-150', 'rpm.limit': 5800 }, ...(truck.job ? { car_job: truck.job } : {}) },
      events: [],
    }));
  }, 50);
  ws.on('close', () => clearInterval(t));
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const api = async (p: string, method = 'GET', body?: unknown) => {
  const res = await fetch(SERVER + p, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return txt; }
};
console.log('waiting for the Co-Driver server to connect to the fake plugin…');
await ready;
await sleep(600);

type Step = { direction: string; banner?: string; lngLat: LL; distance: number; duration: number; exit?: number; then?: string; lanes?: { branches: number[]; active?: number }[] };
type ClientRoute = { line: LL[]; steps: Step[]; stops: { kind: string; name: string; lngLat: LL; n: number; final: boolean }[]; distance: number; duration: number };
async function placeTruck(p: LL, bearing: number) {
  await api('/api/route?all', 'DELETE');
  truck.lngLat = p; truck.bearing = bearing; truck.speed = 0;
  await sleep(500);
}
async function routeTo(dest: LL, name: string, kind = 'point'): Promise<ClientRoute> {
  const r = await api('/api/route', 'POST', { lngLat: dest, name, kind, mode: 'replace' });
  if (!r?.line) throw new Error('no route: ' + JSON.stringify(r));
  return r;
}
const cities = await api('/api/cities') as { name: string; lngLat: LL; rank: number }[];
const cityLL = (name: string) => { const c = cities.find(c => c.name.toLowerCase() === name.toLowerCase()); if (!c) throw new Error('no city ' + name); return c.lngLat; };
const search = async (q: string) => await api('/api/search?q=' + encodeURIComponent(q)) as { kind: string; name: string; detail: string; lngLat: LL }[];

// steps with their position along the (exact) route line, in map metres and game metres
function annotate(r: ClientRoute) {
  const cum = cumOf(r.line), total = cum[cum.length - 1];
  const k = r.distance / 20 / total;            // physical (game) metres per map metre on this route (MAP_SCALE 20)
  return { cum, total, k, steps: r.steps.map(s => ({ ...s, along: nearestAlong(r.line, cum, s.lngLat).along })) };
}

if (cmd === 'explore') {
  const from = arg('from', 'bakersfield'), to = arg('to', 'fresno');
  await placeTruck(cityLL(from), Number(arg('bearing', '0')));
  const r = await routeTo(cityLL(to), to);
  const a = annotate(r);
  console.log(`${from} → ${to}: ${(r.distance / 1609).toFixed(1)} mi, ${r.steps.length} steps, line ${(a.total / 1000).toFixed(1)} km map, k=${a.k.toFixed(4)}`);
  a.steps.forEach((s, i) => {
    const lanes = s.lanes ? s.lanes.map(l => (l.active != null ? '[' + l.branches.join('/') + ']' : l.branches.join('/'))).join(' ') : '';
    console.log(`${String(i).padStart(3)} @${(s.along * a.k / 1609).toFixed(2).padStart(7)} mi  dir ${s.direction.padStart(3)}  ${(s.banner ?? '').padEnd(28)} then=${s.then ?? '-'}  ${lanes}  ${s.lngLat.map(v => v.toFixed(5)).join(',')}`);
  });
  wss.close(); process.exit(0);
}

// ------------------------------------------------------------------ scenes
// A scene's route: the drawn line (smoothed like the app), speed caps, maneuvers and stops, in map metres.
function sceneRoute(r: ClientRoute, from = 0, to = Infinity) {
  const a = annotate(r);
  const lo = Math.max(0, from), hi = Math.min(a.total, to);
  const cut: LL[] = [pointAt(r.line, a.cum, lo).p];
  for (let i = 0; i < r.line.length; i++) if (a.cum[i] > lo && a.cum[i] < hi) cut.push(r.line[i]);
  cut.push(pointAt(r.line, a.cum, hi).p);
  const line = smoothRoute(cut);
  const cum = cumOf(line);
  const caps = speedCaps(line);
  const rr = (v: number) => +v.toFixed(6);
  return {
    k: +a.k.toFixed(5),
    line: line.flatMap(p => [rr(p[0]), rr(p[1])]),
    caps: caps.map(c => +c.toFixed(1)),
    steps: a.steps.filter(s => s.along > lo - 1 && s.along < hi + 1).map(s => ({
      d: s.direction, b: s.banner ?? '', then: s.then, exit: s.exit, lanes: s.lanes,
      at: +nearestAlong(line, cum, s.lngLat).along.toFixed(1),
    })),
    stops: r.stops.map(s => ({ n: s.n, kind: s.kind, name: s.name, final: s.final, at: +nearestAlong(line, cum, s.lngLat).along.toFixed(1), d: +nearestAlong(line, cum, s.lngLat).d.toFixed(1), ll: [rr(s.lngLat[0]), rr(s.lngLat[1])] })),
    length: +cum[cum.length - 1].toFixed(1),
  };
}
const sceneFile = (name: string, data: unknown) => {
  fs.mkdirSync(OUT, { recursive: true });
  const f = path.join(OUT, name + '.json');
  fs.writeFileSync(f, JSON.stringify(data));
  console.log(`  wrote ${path.relative(process.cwd(), f)} (${(fs.statSync(f).size / 1024).toFixed(0)} KB)`);
};
const recipes = (await import('./recipes.ts')).recipes;
const only = arg('only', '');
for (const rec of recipes) {
  if (only && !only.split(',').includes(rec.name)) continue;
  console.log(`scene ${rec.name}`);
  const data = await rec.make({ OUT, actionSpots, api, placeTruck, routeTo, cityLL, search, annotate, sceneRoute, excerpt, pointAt, cumOf, metres, bearingOf, nearestAlong, truck, sleep });
  sceneFile(rec.name, data);
}
wss.close();
process.exit(0);
