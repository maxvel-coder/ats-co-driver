// Scene recipes for the website: where each animated scene takes place. Every route comes from the
// real Co-Driver server (same routing, maneuvers, lanes and stop suggestions as in the app); the map
// around it is cut from the same map file the app draws. Story: a "Used cars" job from Bakersfield
// to Aron in Fresno on CA-99, plus two busy Los Angeles interchanges for lanes and voice.
import fs from 'node:fs';
import path from 'node:path';

type LL = [number, number];
const CRUISE = 26.8;   // game m/s ≈ 60 mph

export const recipes: { name: string; make: (t: any) => Promise<unknown> }[] = [];
const scene = (name: string, make: (t: any) => Promise<unknown>) => recipes.push({ name, make });

// Put the car on `route` some seconds (at cruise speed) before the maneuver picked by `pick`,
// facing along the road, and route again from there.
async function startBefore(t: any, r: any, pick: (s: any) => boolean, sec: number, dest: { ll: LL; name: string; kind?: string }) {
  const a = t.annotate(r);
  const step = a.steps.find(pick);
  if (!step) throw new Error('maneuver not found');
  const at = Math.max(0, step.along - (sec * CRUISE) / a.k);
  const p = t.pointAt(r.line, a.cum, at).p, q = t.pointAt(r.line, a.cum, at + 60).p;
  await t.placeTruck(p, t.bearingOf(p, q));
  return await t.routeTo(dest.ll, dest.name, dest.kind ?? 'point');
}
const linePts = (sr: any): LL[] => { const out: LL[] = []; for (let i = 0; i < sr.line.length; i += 2) out.push([sr.line[i], sr.line[i + 1]]); return out; };
const logSteps = (label: string, sr: any) => console.log(`  ${label}: ${(sr.length / 1000).toFixed(1)} km map, ${sr.steps.length} steps: ${sr.steps.map((s: any) => `${s.d}${s.b ? ' ' + s.b : ''}${s.lanes ? ` [${s.lanes.length} lanes]` : ''}@${(s.at / 1000).toFixed(1)}`).join(' | ')}`);

// the job: Used cars, Bakersfield → Aron, Fresno
async function aronFresno(t: any): Promise<{ ll: LL; name: string; kind: string }> {
  const hits = await t.search('aron');
  const h = hits.find((x: any) => x.kind === 'company' && /fresno/i.test(x.detail));
  if (!h) throw new Error('Aron, Fresno not found');
  return { ll: h.lngLat, name: 'Aron, Fresno', kind: 'company' };
}

// Hero + delivery: the end of the job — CA-99 north into Fresno, off at the exit, through town to Aron.
scene('hero', async t => {
  const dest = await aronFresno(t);
  await t.placeTruck(t.cityLL('bakersfield'), 0);
  const whole = await t.routeTo(dest.ll, dest.name, dest.kind);
  const r = await startBefore(t, whole, (s: any) => /^Exit/.test(s.banner ?? ''), 32, dest);
  const main = t.sceneRoute(r);
  logSteps('route', main);
  return { kind: 'drive', routes: { main }, map: t.excerpt(linePts(main), { near: 16000, far: 45000, tol: 6, digits: 5 }) };
});

// Junction: Los Angeles — a 3-lane freeway split ("keep right, use the middle lane"), then on along the
// freeway: zooms in 21 s before (busy: 3 lanes), shows the lanes, and glides back out at speed.
scene('junction', async t => {
  await t.placeTruck(t.cityLL('los angeles'), 0);
  const sd = { ll: t.cityLL('san diego') as LL, name: 'San Diego' };
  const whole = await t.routeTo(sd.ll, sd.name);
  const wa = t.annotate(whole);
  const wi = wa.steps.findIndex((s: any, i: number) => s.direction === '11' && s.lanes?.length === 3 && wa.steps[i + 1]?.direction === '0');
  if (wi < 0) throw new Error('freeway split not found');
  const target = wa.steps[wi].lngLat;
  const r = await startBefore(t, whole, (s: any) => s.lngLat[0] === target[0] && s.lngLat[1] === target[1], 34, sd);
  const all = t.sceneRoute(r);
  const i = all.steps.findIndex((s: any) => s.d === '11' && s.lanes?.length === 3);
  const end = (all.steps[i + 1]?.at ?? all.steps[i].at) + (16 * CRUISE) / all.k;
  const main = t.sceneRoute(r, 0, end);
  logSteps('route', main);
  return { kind: 'drive', routes: { main }, map: t.excerpt(linePts(main), { near: 16000, far: 40000, tol: 6, digits: 5 }) };
});

// Voice: Long Beach — keep right off the freeway, then turn right, then turn left in town.
scene('voice', async t => {
  await t.placeTruck(t.cityLL('los angeles'), 0);
  const sd = { ll: t.cityLL('san diego') as LL, name: 'San Diego' };
  const whole = await t.routeTo(sd.ll, sd.name);
  const a = t.annotate(whole);
  const k = a.steps.findIndex((s: any) => s.direction === '12' && s.then === '2');
  if (k < 1) throw new Error('turn pair not found');
  const exitStep = a.steps[k - 1], turnLeft = a.steps[k + 1];
  // the destination: a point in town a little past the two turns (so the route takes the exit and both
  // turns, and ends with the arrival call)
  const dest = { ll: t.pointAt(whole.line, a.cum, turnLeft.along + 3500).p as LL, name: 'your destination' };
  // start ~0.65 game miles before the exit: the early call ("In three quarters of a mile, keep right…
  // use the right lane"), the final one, then the turns in town
  const r = await startBefore(t, whole, (s: any) => s.lngLat[0] === exitStep.lngLat[0] && s.lngLat[1] === exitStep.lngLat[1], 40, dest);
  const main = t.sceneRoute(r);
  logSteps('route', main);
  if (!main.steps.some((s: any) => s.d === '12')) throw new Error('voice: the route from the start point skips the turns');
  return { kind: 'drive', routes: { main }, map: t.excerpt(linePts(main), { near: 14000, far: 35000, tol: 6, digits: 5 }) };
});

// Points near a route line from the map: [poiType, sprite, name, lng, lat]
function poisNear(t: any, map: any, line: LL[], want: (p: any[]) => boolean) {
  const cum = t.cumOf(line);
  return map.pois.filter(want).map((p: any[]) => { const n = t.nearestAlong(line, cum, [p[3], p[4]]); return { p, along: n.along / cum[cum.length - 1], off: n.d }; });
}

// Stops: Fresno — route to the job, add a stop, add a closer one (it becomes 1), remove the first.
scene('stops', async t => {
  const dest = await aronFresno(t);
  await t.placeTruck(t.cityLL('bakersfield'), 0);
  const whole = await t.routeTo(dest.ll, dest.name, dest.kind);
  const r0 = await startBefore(t, whole, (s: any) => /^Exit/.test(s.banner ?? ''), 75, dest);
  const A = t.sceneRoute(r0);
  const line = linePts(A);
  const probe = t.excerpt(line, { near: 12000, far: 12000, tol: 10, digits: 5 });
  const comps = poisNear(t, probe, line, p => p[0] === 'company').filter((c: any) => c.off > 1500 && c.off < 9000 && c.along > 0.4).sort((a: any, b: any) => b.along - a.along);
  // the second (closer) stop: a fuel station or rest area well before the first one
  const fuels = poisNear(t, probe, line, p => p[0] === 'facility' && (p[1] === 'gas_ico' || p[1] === 'parking_ico'))
    .filter((c: any) => c.off < 8000 && c.along > 0.03 && (!comps.length || c.along < comps[0].along - 0.15))
    .sort((a: any, b: any) => (a.p[1] === 'gas_ico' ? 0 : 1) - (b.p[1] === 'gas_ico' ? 0 : 1) || a.off - b.off);
  if (!comps.length || !fuels.length) throw new Error(`stops: no candidates (${comps.length} companies, ${fuels.length} fuel)`);
  const P1 = comps[0].p, P2 = fuels[0].p;
  console.log(`  stop 1: ${P1[2]} (${(comps[0].off / 1000).toFixed(1)} km off), closer stop: fuel (${(fuels[0].off / 1000).toFixed(1)} km off)`);
  const rB = await t.api('/api/route', 'POST', { lngLat: [P1[3], P1[4]], name: P1[2], kind: 'point', mode: 'add' });
  const B = t.sceneRoute(rB);
  const p2fuel = P2[1] === 'gas_ico';
  const rC = await t.api('/api/route', 'POST', { lngLat: [P2[3], P2[4]], name: p2fuel ? 'Fuel station' : 'Rest area', kind: p2fuel ? 'fuel' : 'rest', mode: 'add' });
  const C = t.sceneRoute(rC);
  const p1id = rC.stops.find((s: any) => s.name === P1[2])?.id;
  const rD = await t.api('/api/route/stop/' + p1id, 'DELETE');
  const D = t.sceneRoute(rD);
  for (const [n, s] of Object.entries({ A, B, C, D })) logSteps(n, s);
  const all = [...line, ...linePts(B), ...linePts(C)];
  return { kind: 'overview', routes: { A, B, C, D }, points: { P1: [P1[3], P1[4]], P1name: P1[2], P2: [P2[3], P2[4]] }, map: t.excerpt(all, { near: 14000, far: 30000, tol: 8, digits: 5 }) };
});

// Smart stops: CA-99 between Bakersfield and Fresno — fuel / rest / mechanic suggestions. The car moves
// up the highway until the server's own pick (the stop with the least detour, as in the app) lies
// 20–50 s ahead with a short detour; then the suggestion is accepted (route via the station).
scene('suggest', async t => {
  // interstates with roadside truck stops; the first corridor that has a good pick wins for each kind
  const corridors: [string, string][] = [['barstow', 'las vegas'], ['bakersfield', 'sacramento'], ['sacramento', 'redding'], ['los angeles', 'barstow'], ['bakersfield', 'fresno']];
  const variants: Record<string, any> = {};
  const need = new Set(['fuel', 'rest', 'service']);
  const used: LL[] = [];
  for (const [fromCity, toCity] of corridors) {
    if (!need.size) break;
    let from: LL, to: LL;
    try { from = t.cityLL(fromCity); to = t.cityLL(toCity); } catch { console.log(`  (no ${fromCity} / ${toCity} on this map)`); continue; }
    const dest = { ll: to, name: toCity.replace(/\b\w/g, c => c.toUpperCase()), kind: 'point' };
    await t.placeTruck(from, 0);
    const whole = await t.routeTo(dest.ll, dest.name);
    const a = t.annotate(whole);
    console.log(`  corridor ${fromCity} → ${toCity}: ${(whole.distance / 1609).toFixed(0)} mi`);
    for (let f = 0.06; f < 0.94 && need.size; f += 0.015) {
      const at = a.total * f;
      const p = t.pointAt(whole.line, a.cum, at).p, q = t.pointAt(whole.line, a.cum, at + 60).p;
      await t.placeTruck(p, t.bearingOf(p, q));
      for (const kind of [...need]) {
        const before = await t.routeTo(dest.ll, dest.name);
        const s = await t.api('/api/suggest', 'POST', { kind });
        if (!s?.lngLat || used.some(u => t.metres(u, s.lngLat) < 3000)) continue;   // a different station per kind
        const bc = t.cumOf(before.line);
        const n = t.nearestAlong(before.line, bc, s.lngLat);
        const k = before.distance / 20 / bc[bc.length - 1];
        const aheadSec = (n.along * k) / CRUISE;
        if (n.d > 9000 || aheadSec < 22 || aheadSec > 50 || (s.detour ?? 9999) > 900) continue;
        await t.api('/api/suggestion/accept', 'POST');
        await t.sleep(300);
        const via = await t.api('/api/route');
        const Bfull = t.sceneRoute(before), Vfull = t.sceneRoute(via);
        const vstop = Vfull.stops.find((x: any) => !x.final);
        if (!vstop || Vfull.length - Bfull.length > 40000) continue;      // a detour through a whole town: further on
        // only what the scene shows: up to the station (and a little beyond) on both routes
        const V = t.sceneRoute(via, 0, vstop.at + 25000), B = t.sceneRoute(before, 0, n.along + 30000);
        const stop = V.stops.find((x: any) => !x.final);
        logSteps(kind + ' before', B); logSteps(kind + ' via', V);
        console.log(`  ${kind}: ${s.name}, ${aheadSec.toFixed(0)} s ahead, detour ${Math.round((s.detour ?? 0) / 60)} game min`);
        used.push(s.lngLat);
        // the scene drives the via-route up to the stop (and a bit of the old route for the start)
        const vpts = linePts(V), vcum = t.cumOf(vpts);
        const vp = vpts.filter((_, i) => vcum[i] <= stop.at + 3000);
        variants[kind] = { name: s.name, detour: s.detour ?? null, station: s.lngLat, corridor: [fromCity, toCity], dest: dest.name, before: B, via: V,
          map: t.excerpt([...vp, ...linePts(B).slice(0, 120)], { near: 16000, far: 40000, tol: 6, digits: 5 }) };
        need.delete(kind);
      }
    }
  }
  for (const k of need) console.log(`  ${k}: no station close enough along any corridor`);
  return { kind: 'drive', variants };
});

// Enter helper: the last part of the suggest scene's fuel detour, in close-up — pull into the
// station and stop at the pumps.
scene('enter', async t => {
  const sg = JSON.parse(fs.readFileSync(path.join(t.OUT, 'suggest.json'), 'utf8'));
  const v = sg.variants.fuel ?? Object.values(sg.variants)[0];
  if (!v) throw new Error('run the suggest scene first');
  const stop = v.via.stops.find((x: any) => !x.final);
  // from ~1 game mile before the station's exit to the station
  const exit = [...v.via.steps].reverse().find((s: any) => s.at < stop.at - 50 && ['11', '1', '12', '2'].includes(s.d));
  const from = Math.max(0, (exit?.at ?? stop.at) - 9000);
  const pts = linePts(v.via);
  const cum = t.cumOf(pts);
  const sub: LL[] = pts.filter((_, i) => cum[i] >= from && cum[i] <= stop.at + 50);
  const map = t.excerpt(sub, { near: 6000, far: 14000, tol: 0.6, digits: 6 });
  // the pump: the game's own refuel spot nearest to the station (as the app's Enter button uses)
  const pumps = await t.actionSpots(stop.ll, 3000, 'fuel');
  const spot: LL = pumps[0]?.ll ?? stop.ll;
  console.log(`  ${v.name}: from ${(from / 1000).toFixed(1)} km to the stop at ${(stop.at / 1000).toFixed(1)} km; ${pumps.length} pumps, nearest ${pumps[0] ? pumps[0].d.toFixed(0) + ' m' : '—'} from the road point`);
  return { kind: 'drive', name: v.name, from, stopAt: stop.at, route: 'suggest:fuel', spot: [+spot[0].toFixed(6), +spot[1].toFixed(6)], pumps: pumps.slice(0, 8).map((p: any) => [+p.ll[0].toFixed(6), +p.ll[1].toFixed(6)]), map };
});
