// ATS Co-Driver server: bridges the in-game Co-Driver plugin to phone/tablet dashboards.
//
//   plugin (ws://127.0.0.1:25555/ws)  -->  this server  -->  dashboards (http://<pc>:8080)
//
// - Relays live telemetry and button presses.
// - Plans routes with truckermudgeon's navigation code over the game's own road graph.
// - Serves vector map tiles cut on the fly from the generated GeoJSON.
// - Watches fuel / rest / damage needs and suggests the best stop; speaks directions.
// - Keeps the user's map, settings and favourites in %LOCALAPPDATA%\ATS Co-Driver.
//
// Copyright (C) ATS Co-Driver contributors. Licensed under the GNU GPL v3 or later (see LICENSE);
// built on truckermudgeon/maps (GPL-3.0-or-later).

import polyline from '@mapbox/polyline';
import { fromDir } from '@truckermudgeon/io';
import { AtsDlcGuards, AtsScsSourceToDlcGuard } from '@truckermudgeon/map/constants';
import { toMapPosition } from '@truckermudgeon/map/prefabs';
import type { PrefabDescription } from '@truckermudgeon/map/types';
import {
  fromAtsCoordsToWgs84,
  fromWgs84ToAtsCoords,
} from '@truckermudgeon/map/projections';
import { createRouteKey, findRouteFromKey, type Context } from '@truckermudgeon/map/routing';
import geojsonvt from 'geojson-vt';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vtpbf from 'vt-pbf';
import { renderSVG } from 'uqr';
import { WebSocket, WebSocketServer } from 'ws';
import { generateRouteFromKeys, generateRoutes, type RouteWithLookup } from '../../apis/navigation/domain/actor/generate-routes';
import { readGraphAndMapData } from '../../apis/navigation/infra/lookups/graph-and-map';

// ------------------------------------------------------------------ paths & config

// Two places: the PROGRAM folder (this server, the web app, the voice engine, read-only, from the
// installer) and the user's HOME folder in %LOCALAPPDATA% (the map built from their own game, the
// voice model, settings). The launcher passes both; the defaults work when running from source.
const PROGRAM_DIR = process.env.CODRIVER_PROGRAM_DIR ?? import.meta.dirname;
const HOME = process.env.CODRIVER_HOME ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ATS Co-Driver');
const MAP_DIR = path.join(HOME, 'map', 'parser');
const GEOJSON = path.join(HOME, 'map', 'gen', 'usa-map.geojson');
const SPRITES_DIR = path.join(HOME, 'map', 'sprites');   // icons cut from the user's own game files
const APP_DIR = process.env.CODRIVER_WEB_DIR ?? path.join(PROGRAM_DIR, 'web');
const DATA_DIR = path.join(HOME, 'data');
const MAPLIBRE_DIR = process.env.CODRIVER_MAPLIBRE_DIR ?? path.resolve(import.meta.dirname, '../../../node_modules/maplibre-gl/dist');
// the game's own folder in Documents (may be redirected, e.g. to OneDrive), the launcher knows it
const GAME_DOCS = process.env.CODRIVER_GAME_DOCS ?? path.join(os.homedir(), 'Documents', 'American Truck Simulator');
const PLUGIN_WS = 'ws://127.0.0.1:25555/ws';
// ATS compresses its world ~1:20 outside cities; trip distances are shown in game miles like the
// in-game map and job planner. Turn countdowns stay in physical metres (what the driver sees).
const MAP_SCALE = 20;
const PORT = Number(process.env.CODRIVER_PORT) || 8080;

fs.mkdirSync(DATA_DIR, { recursive: true });
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ------------------------------------------------------------------ settings & favourites

const DEFAULT_SETTINGS = {
  units: 'imperial' as 'imperial' | 'metric',
  theme: 'auto' as 'auto' | 'day' | 'night',
  routeMode: 'fastest' as 'fastest' | 'shortest' | 'smallRoads',
  autoRouteJob: true,
  suggestions: 'ask' as 'ask' | 'auto' | 'off',
  fuel: { enabled: true, thresholdPct: 25, prefer: 'nearest' as 'nearest' | 'withRest' },
  rest: {
    enabled: true,
    thresholdMin: 60,               // ask this many game-minutes before a planned / needed rest stop
    prefer: 'any' as 'any' | 'withFuel',
    planOnRoute: true,              // pick rest stops along the active route, not just the nearest one
    useSpareTime: true,             // arriving early → rest at the last stop before the destination
    durationMin: 600,               // how long a rest takes in game minutes (sleep), used for spare-time planning
  },
  speeding: { enabled: true, toleranceMph: 5 },
  damage: { enabled: true, thresholdPct: 10 },   // suggest a service station when any part is this damaged
  actionPrompt: { enabled: true },               // big "Enter" button when stopped at a company / station / rest area
  keepAwake: true,                               // dashboards keep the screen on while their tab is in front
  delivery: { windowHours: 5 },                  // guessed delivery window length when none was entered (0 = no guess)
  // Voice: 'pc' = Windows voice on this PC (headset, with the game sound), 'device' = the dashboards
  // speak, 'off'. rate -10..10, volume 0..100.
  voice: { output: 'pc' as 'pc' | 'device' | 'off', guidance: true, stops: true, suggestions: true, rate: 1, volume: 90, pcVoice: '', earlyM: 2000 },   // earlyM: highway early call (m before)
  // Map + routing limited to the states the game actually loads ('owned'), or everything ('all').
  mapDlc: 'owned' as 'owned' | 'all',
  // Arrival estimate: time spent at stops (game minutes) and waiting at traffic lights / stop signs
  // (real seconds, city traffic runs at the game's city time scale).
  eta: { fuelStopMin: 15, serviceStopMin: 25, pointStopMin: 0, lightWaitSec: 15, stopSignWaitSec: 4 },
  // Junction view: zoom in ahead of turns / busy interchanges, timed by speed (seconds before the
  // maneuver), and show which lanes to use.
  junction: { autoZoom: true, leadSec: 15, lanes: true, vibrate: true },
  camera: { enabled: true, autoOnReverse: true },
  // Widget layout per screen ('phone-portrait', 'tablet-landscape', …): widget ids per zone
  // (quick / cluster / side / dock). Missing entry → the app's default layout.
  layouts: {} as Record<string, Record<string, string[]>>,
  telltales: null as string[] | null,   // warning lights shown in the telltale widget (null = all)
  telltalesHideOff: false,
  buttons: ['engine', 'light', 'hblight', 'flasher4way', 'lblinker', 'rblinker', 'wipers', 'parkingbrake', 'cruiectrl', 'horn', 'parking_cams', 'beacon'],
};
type Settings = typeof DEFAULT_SETTINGS;

function readJson<T>(file: string, fallback: T): T {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')) };
  } catch {
    return fallback;
  }
}
function writeJson(file: string, value: unknown) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}
// Deep-merge so settings saved by an older version pick up newly added nested defaults.
function mergeDeep<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? mergeDeep(b, v) : v;
  }
  return out as T;
}
let settings: Settings = mergeDeep(DEFAULT_SETTINGS, readJson<Partial<Settings>>('settings.json', {}));
interface Favourite { id: string; name: string; lngLat: [number, number]; createdAt: number }
let favourites: Favourite[] = readJson<{ list: Favourite[] }>('favourites.json', { list: [] }).list;

// ------------------------------------------------------------------ map & routing data

log('loading map + graph data (takes a minute)...');
const t0 = Date.now();
const gm = readGraphAndMapData(fromDir(MAP_DIR), 'usa');
const { tsMapData, graphData, graphNodeRTree } = gm;
const routeContext: Context = {
  nodeLUT: tsMapData.nodes,
  graph: graphData.graph,
  enabledDlcGuards: new Set(Array.from({ length: 70 }, (_, i) => i)),
  map: 'usa',
};
const routing = {
  findRouteFromKey: async (key: Parameters<typeof findRouteFromKey>[0]) => findRouteFromKey(key, routeContext),
};
const quietSink = { publish: (e: { type: string }) => { if (e.type === 'error') log('nav:', JSON.stringify(e).slice(0, 200)); } };

// ---- owned map DLCs
// The game's log lists every .scs it actually mounts after the Steam ownership check. Stray files
// of map DLCs that aren't owned (e.g. old copies) are opened but never mounted, so the mounted list
// is the truth. Every map item and road-graph edge carries a DLC guard (the DLC, or pair of DLCs at
// a border, it belongs to); only guards whose DLCs are all owned are drawn and routed through.
const GAME_LOG = path.join(GAME_DOCS, 'game.log.txt');
const ALL_GUARDS = new Set(Object.keys(AtsDlcGuards).map(Number));
let ownedMapDlcs: string[] | null = null;     // mounted state DLC files, e.g. ['dlc_tx.scs', …]; null = unknown
let gameLogMtime = 0;
function readMountedMapDlcs(): string[] | null {
  try {
    const st = fs.statSync(GAME_LOG);
    gameLogMtime = st.mtimeMs;
    const txt = fs.readFileSync(GAME_LOG, 'utf8');
    const mounted = [...txt.matchAll(/\[fs\] device .*?\/(dlc_[a-z0-9_]+\.scs) mounted/g)].map(m => m[1]);
    if (!mounted.length) return null;   // log from an unfinished start, keep what we had
    return [...new Set(mounted.filter(f => AtsScsSourceToDlcGuard[f] != null && AtsScsSourceToDlcGuard[f] !== 0))].sort();
  } catch { return null; }
}
function guardsFor(dlcFiles: string[] | null): Set<number> {
  if (!dlcFiles || settings.mapDlc === 'all') return new Set(ALL_GUARDS);
  const owned = new Set(dlcFiles.flatMap(f => [...AtsDlcGuards[AtsScsSourceToDlcGuard[f]]]));
  const out = new Set<number>();
  for (const [g, dlcs] of Object.entries(AtsDlcGuards)) if ([...dlcs].every(d => owned.has(d))) out.add(Number(g));
  return out;   // includes 0 (base map) and guards with an unknown (empty) DLC set
}
ownedMapDlcs = readMountedMapDlcs();
let enabledGuards = guardsFor(ownedMapDlcs);
routeContext.enabledDlcGuards = enabledGuards;
const guardOk = (g: unknown) => typeof g !== 'number' || enabledGuards.has(g);
// A graph node is usable when at least one of its road connections is in an owned state.
let usableNodes = new Set<bigint>();
function refreshUsableNodes() {
  usableNodes = new Set();
  for (const [uid, n] of graphData.graph) if ([...n.forward, ...n.backward].some(e => enabledGuards.has(e.dlcGuard))) usableNodes.add(uid);
}
refreshUsableNodes();
const ownedStateNames = () => (ownedMapDlcs ?? []).map(f => f.replace(/^dlc_|\.scs$/g, '').toUpperCase());
log(`map DLCs mounted by the game: ${ownedMapDlcs ? ownedStateNames().join(' ') : 'unknown (no game log), showing all'}; ${enabledGuards.size}/${ALL_GUARDS.size} guards enabled`);

log(`map data ready in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${graphData.graph.size} graph nodes, ${graphData.serviceAreas.size} service areas`);

const toLngLat = (x: number, y: number) => fromAtsCoordsToWgs84([x, y]) as [number, number];
// Map metres per game metre (the map projection blows the game world up to real US size), measured
// on the projection itself. Roads and the route are drawn at their true width with it.
const MAP_M_PER_GAME_M = (() => {
  const a = fromAtsCoordsToWgs84([0, 0]), b = fromAtsCoordsToWgs84([1000, 0]);
  const k = Math.PI / 180, dLat = (b[1] - a[1]) * k, dLng = (b[0] - a[0]) * k * Math.cos(((a[1] + b[1]) / 2) * k);
  return (Math.sqrt(dLat * dLat + dLng * dLng) * 6371000) / 1000;
})();
const LANE_M = 4.5;   // ATS lane width (game metres)
// true road width in map metres from the lane layout (prefab roads without lane data: by road type)
function roadWidthMapM(p: Record<string, unknown>) {
  const l = Math.max(0, Number(p.leftLanes) || 0), r = Math.max(0, Number(p.rightLanes) || 0);
  const lanes = l + r || ({ freeway: 4, divided: 4, local: 2 } as Record<string, number>)[String(p.roadType)] || 2;
  const game = lanes * LANE_M + Math.max(0, Number(p.offset) || 0) + 0.5 * ((Number(p.shoulderSpaceLeft) || 0) + (Number(p.shoulderSpaceRight) || 0));
  return Math.round(game * MAP_M_PER_GAME_M);
}

// ---- time zones: the game clock (game.time, delivery.time) runs on Pacific time (UTC−7, the
// California base: deadlines matched the in-game job screen exactly there). Elsewhere the in-game
// clock shows local time; each state's zone (and split-state areas) comes from the map data.
const BASE_TZ_MIN = -420;
const countries = JSON.parse(fs.readFileSync(path.join(MAP_DIR, 'usa-countries.json'), 'utf8')) as { token: string; code: string; timeZone: number; timeZoneName: string; secondaryTimeZones?: { extent: [number, number, number, number]; timeZone: number }[] }[];
const countryByToken = new Map(countries.map(c => [c.token, c]));
const TZ_ABBR: Record<number, string> = { [-480]: 'PT', [-420]: 'PT', [-360]: 'MT', [-300]: 'CT', [-240]: 'ET' };
// zone offset (minutes vs UTC) at a game position: state of the nearest city, then split-zone areas
function tzAt(x: number, y: number): { offset: number; abbr: string } {
  let best: { state: string; d: number } | null = null;
  for (const c of cities.values()) { const d = Math.hypot(c.x - x, c.y - y); if (!best || d < best.d) best = { state: c.state, d }; }
  const country = best ? countryByToken.get(best.state) : undefined;
  let tz = country?.timeZone ?? BASE_TZ_MIN;
  for (const s of country?.secondaryTimeZones ?? []) if (x >= s.extent[0] && x <= s.extent[2] && y >= s.extent[1] && y <= s.extent[3]) tz = s.timeZone;
  const name = String(country?.timeZoneName ?? '');
  const abbr = /mst|mdt/.test(name) && tz === country?.timeZone ? 'MT' : TZ_ABBR[tz] ?? `UTC${tz / 60}`;
  return { offset: tz, abbr };
}
// minutes to add to a game-clock time to get local time at that position
const localShift = (x: number, y: number) => tzAt(x, y).offset - BASE_TZ_MIN;

// Cities and companies for search + job lookup.
const cities = new Map<string, { name: string; state: string; x: number; y: number; dlcGuard?: number }>();
for (const c of tsMapData.cities.values()) cities.set(c.token, { name: c.name, state: c.countryToken, x: c.x, y: c.y, dlcGuard: (c as { dlcGuard?: number }).dlcGuard });
const companyNames = new Map<string, string>();
for (const d of tsMapData.companyDefs?.values?.() ?? []) companyNames.set((d as { token: string }).token, (d as { name: string }).name);

interface Stop { nodeUid: bigint; facilities: Set<string>; x: number; y: number; description: string }
const allStops: Stop[] = [];
for (const [nodeUid, sa] of graphData.serviceAreas) {
  const n = tsMapData.nodes.get(nodeUid);
  if (n) allStops.push({ nodeUid, facilities: sa.facilities as Set<string>, x: n.x, y: n.y, description: sa.description });
}
let stops: Stop[] = allStops.filter(s => usableNodes.has(s.nodeUid));   // only stations in owned states

// ------------------------------------------------------------------ vector tiles

log('indexing map tiles...');
const gj = JSON.parse(fs.readFileSync(GEOJSON, 'utf8'));
type GjFeature = { properties: Record<string, unknown>; geometry: { type: string; coordinates: any } };
// City labels for the app (only cities in owned states).
const cityLabels = (gj.features as GjFeature[]).filter(f => f.properties.type === 'city');

// ATS stores roads as many short pieces. Zoomed out, the tile cutter drops lines shorter than its
// simplification tolerance (~1 px), so whole roads vanished piece by piece. Joining connected pieces
// of the same kind into long lines keeps every road visible at every zoom.
type LineFeature = { type: 'Feature'; properties: Record<string, unknown>; geometry: { type: 'LineString'; coordinates: [number, number][] } };
function mergeRoadPieces(features: LineFeature[]): LineFeature[] {
  const key = (c: [number, number]) => `${c[0].toFixed(5)},${c[1].toFixed(5)}`;
  const groups = new Map<string, LineFeature[]>();
  for (const f of features) {
    if (f.geometry.type !== 'LineString') continue;
    // Local and divided roads are joined as one class (chains used to break wherever a road changed
    // type at an intersection, leaving short pieces that got dropped); freeways stay separate.
    const cls = f.properties.roadType === 'freeway' ? 'freeway' : 'other';
    const g = `${f.properties.type}|${cls}|${f.properties.secret === true}`;
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(f);
  }
  const out: LineFeature[] = [];
  for (const group of groups.values()) {
    const segs = group.map(f => f.geometry.coordinates);
    const used = new Uint8Array(segs.length);
    const ends = new Map<string, number[]>();
    segs.forEach((s, i) => {
      for (const k of [key(s[0]), key(s[s.length - 1])]) (ends.get(k) ?? ends.set(k, []).get(k)!).push(i);
    });
    const extend = (line: [number, number][]) => {
      for (;;) {
        const k = key(line[line.length - 1]);
        const j = (ends.get(k) ?? []).find(n => !used[n]);
        if (j === undefined) return;
        used[j] = 1;
        const s = segs[j];
        const next = key(s[0]) === k ? s : [...s].reverse();
        for (let i = 1; i < next.length; i++) line.push(next[i]);
      }
    };
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const line = [...segs[i]];
      extend(line);
      line.reverse();
      extend(line);
      out.push({ type: 'Feature', properties: group[i].properties, geometry: { type: 'LineString', coordinates: line } });
    }
  }
  return out;
}
const vt = (fc: unknown, tolerance = 3) => geojsonvt(fc as never, { maxZoom: 15, indexMaxZoom: 4, tolerance, buffer: 64 });

// Tile indexes from the features of owned states only (rebuilt when the owned DLCs change).
function buildTileIndex() {
  const fc = () => ({ type: 'FeatureCollection' as const, features: [] as unknown[] });
  const layers = { areas: fc(), roads: fc(), pois: fc() };
  let skipped = 0;
  for (const f of gj.features as GjFeature[]) {
    const t = f.properties.type as string;
    if (f.properties.hidden === true) continue;
    if (!guardOk(f.properties.dlcGuard)) { skipped++; continue; }
    if (t === 'mapArea' || t === 'prefab') layers.areas.features.push(f);
    else if (t === 'road' || t === 'ferry') { if (t === 'road') f.properties.w = roadWidthMapM(f.properties); layers.roads.features.push(f); }
    else if (t === 'poi' || t === 'traffic') layers.pois.features.push(f);
  }
  const mergedRoads = { type: 'FeatureCollection' as const, features: mergeRoadPieces(layers.roads.features as LineFeature[]) };
  log(`tiles: ${layers.roads.features.length} road pieces → ${mergedRoads.features.length} lines; ${skipped} items of unowned states left out`);
  return {
    areas: vt(layers.areas),
    roads: vt(layers.roads),
    // Tolerances measured on a real route: z5 98 %, z6+ 100 % of the road drawn, tiles <= ~300 KB.
    roadsSimple: vt(mergedRoads, 2),
    roadsFar: vt(mergedRoads, 3),
    pois: vt(layers.pois),
  };
}
let tileIndex = buildTileIndex();
const tileCache = new Map<string, Buffer>();
let TILE_ETAG = `"tiles-${Date.now()}"`;   // changes on every server start and every map rebuild
function getTile(z: number, x: number, y: number): Buffer | null {
  const key = `${z}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached) return cached;
  const tile: Record<string, unknown> = {};
  // (City names are drawn by the app itself, so no label layer is sent.)
  // Every road at every zoom (simplified below z8, ~150-300 KB per tile measured), like the in-game map.
  // Icons from z4 so fuel / services / companies can be spotted zoomed out.
  const plan: [string, keyof typeof tileIndex][] =
    z < 4 ? [['roads', 'roadsFar']]
    : z < 5 ? [['roads', 'roadsFar'], ['pois', 'pois']]
    : z < 8 ? [['roads', 'roadsSimple'], ['pois', 'pois']]
    : z < 10 ? [['areas', 'areas'], ['roads', 'roadsSimple'], ['pois', 'pois']]
    : [['areas', 'areas'], ['roads', 'roads'], ['pois', 'pois']];
  for (const [name, idxName] of plan) {
    const t = (tileIndex[idxName] as { getTile: (z: number, x: number, y: number) => unknown }).getTile(z, x, y);
    if (t) tile[name] = t;
  }
  if (!Object.keys(tile).length) return null;
  const buf = Buffer.from(vtpbf.fromGeojsonVt(tile as never, { version: 2 }));
  if (tileCache.size > 4000) tileCache.clear();
  tileCache.set(key, buf);
  return buf;
}
const [minLng, minLat, maxLng, maxLat] = (() => {
  let a = [180, 90, -180, -90];
  for (const f of cityLabels) {
    if (f.geometry.type !== 'Point') continue;
    const [lng, lat] = f.geometry.coordinates;
    a = [Math.min(a[0], lng), Math.min(a[1], lat), Math.max(a[2], lng), Math.max(a[3], lat)];
  }
  return a;
})();
log('tiles ready');

// Bought a state (or removed one)? The game log changes on every game start: re-read it, and when the
// owned map DLCs differ, rebuild tiles, routing and stations and tell the dashboards to reload the map.
setInterval(() => {
  let mtime = 0;
  try { mtime = fs.statSync(GAME_LOG).mtimeMs; } catch { return; }
  if (mtime === gameLogMtime) return;
  const now = readMountedMapDlcs();
  if (!now || JSON.stringify(now) === JSON.stringify(ownedMapDlcs)) return;
  ownedMapDlcs = now;
  applyOwnedDlcs();
}, 30000);
function applyOwnedDlcs() {
  enabledGuards = guardsFor(ownedMapDlcs);
  routeContext.enabledDlcGuards = enabledGuards;
  refreshUsableNodes();
  stops = allStops.filter(s => usableNodes.has(s.nodeUid));
  tileIndex = buildTileIndex();
  tileCache.clear();
  TILE_ETAG = `"tiles-${Date.now()}"`;
  log(`owned map DLCs: ${ownedStateNames().join(' ')} (${settings.mapDlc}); map + routing rebuilt`);
  broadcast({ type: 'mapdata' });
  void replan();
}
// ------------------------------------------------------------------ telemetry from the plugin

type Tel = { game?: string; paused?: boolean; ch: Record<string, any>; cfg: Record<string, Record<string, any>>; events: any[] };
let tel: Tel = { ch: {}, cfg: {}, events: [] };
let pluginWs: WebSocket | null = null;
let pluginConnected = false;

function connectPlugin() {
  const ws = new WebSocket(PLUGIN_WS);
  pluginWs = ws;
  ws.on('open', () => { pluginConnected = true; log('connected to game plugin'); });
  ws.on('message', data => {
    try { tel = JSON.parse(String(data)); onTelemetry(); sendPosition(); } catch { /* ignore partial frames */ }
  });
  ws.on('close', () => { if (pluginConnected) log('game plugin disconnected'); pluginConnected = false; setTimeout(connectPlugin, 2000); });
  ws.on('error', () => { /* close handler retries */ });
}
connectPlugin();

function truckState() {
  const p = tel.ch['truck.world.placement'];
  if (!p) return null;
  return {
    position: { X: p.pos[0], Y: p.pos[1], Z: p.pos[2] },
    orientation: { heading: p.rot[0], pitch: p.rot[1], roll: p.rot[2] },
    speed: { value: tel.ch['truck.speed'] ?? 0 },
  };
}
const truckLngLat = () => { const p = tel.ch['truck.world.placement']; return p ? toLngLat(p.pos[0], p.pos[2]) : null; };
const fuelPct = () => {
  const cap = tel.cfg.truck?.['fuel.capacity'];
  const fuel = tel.ch['truck.fuel.amount'];
  return cap && fuel != null ? (fuel / cap) * 100 : null;
};

// ------------------------------------------------------------------ navigation state

interface Destination { id: string; kind: 'point' | 'job' | 'fuel' | 'rest' | 'service' | 'favourite'; name: string; nodeUid: bigint; lngLat: [number, number] }
interface ActiveRoute {
  stops: Destination[];           // in driving order; the last one is the final destination
  stopEnd: number[];              // index into `line` where the leg to each stop ends (the stop's on-road point)
  traffic: { idx: number; type: 'stop' | 'trafficLight' }[];   // traffic lights / stop signs along the route
  destination: Destination;       // = stops.at(-1)
  line: [number, number][];       // full route geometry (lngLat)
  lineMetres: number;             // length of `line` measured in lngLat space
  physPerLine: number;            // physical game-world metres per lngLat metre (calibrated per route)
  cum: number[];                  // cumulative lngLat metres along `line`
  onRoute: { stop: Stop; index: number }[];   // fuel / rest stops right next to the route, in route order
  stepStart: number[];            // index into `line` where each step begins
  steps: { direction: string; banner?: string; lngLat: [number, number]; distance: number; duration: number; exit?: number; then?: string; lanes?: { branches: number[]; active?: number }[] }[];
  distance: number;
  duration: number;
  createdAt: number;
}
let route: ActiveRoute | null = null;
let routing_busy = false;
let replanQueued = false;
let lastJobKey = '';

// The driver's plan. `waypoints` are the stops picked on the map (and accepted fuel/rest stops);
// their order is recalculated on every replan (shortest trip from the car to the final destination).
// The final destination is the driver's own choice ("Replace route") or else the current job.
let waypoints: Destination[] = [];
let finalDest: Destination | null = null;
let jobDest: Destination | null = null;
let jobRouteOff = false;            // driver pressed End on the plain job route → stay quiet until the next job
let nextId = 1;
const newId = () => String(nextId++);
let offRouteSince = 0;
let arrivedSince = 0;
let lastReroute = 0;
const REROUTE_COOLDOWN_MS = 15000;
const OFF_ROUTE_M = 40;   // physical metres away from the route line before it counts as "left the route"

function nodeForLngLat(lngLat: [number, number]) {
  const [x, y] = fromWgs84ToAtsCoords(lngLat);
  const hit = graphNodeRTree.findClosest(x, y, { radius: 3000, predicate: n => usableNodes.has(n.node.uid) });   // no destinations in states you don't own
  return hit?.node;
}

// ---- plan → ordered stops → one route through all of them

function effectiveFinal(): Destination | null {
  return finalDest ?? (settings.autoRouteJob && !jobRouteOff ? jobDest : null);
}

// Order the stops for the shortest trip (straight-line) from the car, ending at the final
// destination when there is one. Up to 7 stops: every order is tried; more: nearest-neighbour + 2-opt.
function orderStops(ws: Destination[], final: Destination | null, from: [number, number] | null): Destination[] {
  if (ws.length <= 1 || !from) return ws.slice();
  const cost = (seq: Destination[]) => {
    let c = 0, p = from;
    for (const w of seq) { c += metres(p, w.lngLat); p = w.lngLat; }
    return final ? c + metres(p, final.lngLat) : c;
  };
  let best = ws.slice(), bestCost = cost(best);
  if (ws.length <= 7) {
    const permute = (rest: Destination[], acc: Destination[]) => {
      if (!rest.length) { const c = cost(acc); if (c < bestCost) { bestCost = c; best = acc.slice(); } return; }
      for (let i = 0; i < rest.length; i++) permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]]);
    };
    permute(ws, []);
    return best;
  }
  const left = ws.slice(), seq: Destination[] = [];
  let p = from;
  while (left.length) {
    let bi = 0;
    for (let i = 1; i < left.length; i++) if (metres(p, left[i].lngLat) < metres(p, left[bi].lngLat)) bi = i;
    seq.push(left[bi]); p = left[bi].lngLat; left.splice(bi, 1);
  }
  best = seq; bestCost = cost(seq);
  for (let improved = true; improved;) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) for (let k = i + 1; k < best.length; k++) {
      const cand = [...best.slice(0, i), ...best.slice(i, k + 1).reverse(), ...best.slice(k + 1)];
      const c = cost(cand);
      if (c < bestCost - 1e-6) { best = cand; bestCost = c; improved = true; }
    }
  }
  return best;
}

// Route leg from the end of the previous leg to the next stop. The start direction is the one the
// previous leg arrived in (as upstream's addWaypoint does); the other direction is the fallback.
async function legFrom(prev: RouteWithLookup, to: bigint): Promise<RouteWithLookup | undefined> {
  const flat = prev.lookup.nodeUidsFlat;
  const end = flat.at(-1)!, penult = flat.at(-2);
  let dir: 'forward' | 'backward' = penult != null && graphData.graph.get(penult)?.forward.some(n => n.nodeUid === end) ? 'forward' : 'backward';
  if (graphData.serviceAreas.has(end) && (graphData.graph.get(end)?.[dir].length ?? 0) === 0) dir = dir === 'forward' ? 'backward' : 'forward';
  for (const d of [dir, dir === 'forward' ? 'backward' : 'forward'] as const) {
    try {
      const r = await generateRouteFromKeys([createRouteKey(end, to, d, settings.routeMode, 'usa')], { graphAndMapData: gm as never, routing: routing as never });
      if (r?.segments?.length) return r;
    } catch { /* try the other direction */ }
  }
  return undefined;
}

// Recalculate the whole route from the plan. Calls made while a calculation runs are merged into
// one follow-up run, so adding several points quickly never loses one.
async function replan(): Promise<string | null> {
  if (routing_busy) { replanQueued = true; return null; }
  const final = effectiveFinal();
  const ordered = orderStops(waypoints, final, truckLngLat());
  const stopsList = final ? [...ordered, final] : ordered;
  if (!stopsList.length) { if (route) clearRoute(); return null; }
  const err = await buildRoute(stopsList);
  if (replanQueued) { replanQueued = false; return replan(); }
  return err;
}

async function buildRoute(stopsList: Destination[]): Promise<string | null> {
  const truck = truckState();
  if (!truck) return 'No position from the game yet';
  routing_busy = true;
  try {
    const t = Date.now();
    const ctx = { graphAndMapData: gm as never, routing: routing as never, truck: truck as never, domainEventSink: quietSink as never };
    const legs: RouteWithLookup[] = [], used: Destination[] = [], skipped: string[] = [];
    for (const s of stopsList) {
      let leg: RouteWithLookup | undefined;
      try { leg = legs.length ? await legFrom(legs[legs.length - 1], s.nodeUid) : (await generateRoutes(s.nodeUid, [settings.routeMode], ctx))[0]; }
      catch (e) { log('leg error', s.name, String(e).slice(0, 200)); }
      if (!leg) { skipped.push(s.name); continue; }
      legs.push(leg); used.push(s);
    }
    if (!legs.length) return 'No route found';
    const line: [number, number][] = [];
    const stepStart: number[] = [];
    const steps: ActiveRoute['steps'] = [];
    const stopEnd: number[] = [];
    const traffic: ActiveRoute['traffic'] = [];
    let distance = 0, duration = 0;
    legs.forEach((leg, li) => {
      distance += leg.distanceMeters; duration += leg.duration;
      for (const seg of leg.segments) for (const s of seg.steps) {
        const first = line.length;
        stepStart.push(first);
        for (const p of polyline.decode(s.geometry) as [number, number][]) line.push(p);
        // traffic lights / stop signs of this step, placed at the nearest point of its geometry
        for (const ti of s.trafficIcons ?? []) {
          const ll = ti.lonLat;
          let bi = first, bd = Infinity;
          for (let i = first; i < line.length; i++) { const d = metres(ll, line[i]); if (d < bd) { bd = d; bi = i; } }
          traffic.push({ idx: bi, type: ti.type });
        }
        const m = s.maneuver as unknown as {
          direction: string; lonLat: [number, number]; banner?: { text?: string }; roundaboutExitNumber?: number;
          laneHint?: { lanes: { branches: number[]; activeBranch?: number }[] };
          thenHint?: { direction: number };
        };
        const isArrive = Number(m.direction) === -3;
        // laneHint: every lane at the junction with the directions it allows; `activeBranch` is set on
        // the lanes the driver should use for this maneuver.
        steps.push({
          direction: String(m.direction),
          banner: isArrive ? (li < legs.length - 1 ? `Stop ${li + 1}: ${used[li].name}` : used[li].name) : m.banner?.text,
          lngLat: m.lonLat, distance: s.distanceMeters, duration: s.duration,
          exit: m.roundaboutExitNumber,
          then: m.thenHint ? String(m.thenHint.direction) : undefined,
          lanes: m.laneHint?.lanes?.map(l => ({ branches: l.branches.map(Number), active: l.activeBranch != null ? Number(l.activeBranch) : undefined })),
        });
      }
      stopEnd.push(line.length - 1);
    });
    const cum = [0];
    for (let i = 0; i < line.length - 1; i++) cum.push(cum[i] + metres(line[i], line[i + 1]));
    const lineMetres = cum[cum.length - 1];
    const physPerLine = lineMetres > 0 ? distance / lineMetres : 1 / MAP_SCALE;
    const onRoute = stopsAlong(line, physPerLine);
    route = { stops: used, stopEnd, traffic, destination: used[used.length - 1], line, lineMetres, physPerLine, cum, onRoute, stepStart, steps, distance, duration, createdAt: Date.now() };
    offRouteSince = 0; arrivedSince = 0;
    log(`route: ${used.map((s, i) => `${i + 1}.${s.name}`).join(' → ')} · ${((distance * MAP_SCALE) / 1609).toFixed(0)} game mi, ${steps.length} steps, ${onRoute.length} fuel/rest stops along (${Date.now() - t} ms)`);
    if (skipped.length) { log('  unreachable, skipped:', skipped.join(', ')); broadcast({ type: 'notice', text: `Can't reach ${skipped.join(', ')}, skipped` }); }
    broadcast({ type: 'route', route: routeForClient() });
    return null;
  } catch (e) {
    log('route error', String(e).slice(0, 300));
    return 'Route calculation failed';
  } finally {
    routing_busy = false;
  }
}

// Service areas within ~150 physical metres of the route line, ordered along the route.
function stopsAlong(line: [number, number][], physPerLine: number) {
  let [minLng, minLat, maxLng, maxLat] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lng, lat] of line) { minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng); minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat); }
  const pad = 0.05;
  const out: { stop: Stop; index: number }[] = [];
  for (const s of stops) {
    if (!s.facilities.has('parking_ico') && !s.facilities.has('gas_ico') && !s.facilities.has('service_ico')) continue;
    const ll = toLngLat(s.x, s.y);
    if (ll[0] < minLng - pad || ll[0] > maxLng + pad || ll[1] < minLat - pad || ll[1] > maxLat + pad) continue;
    let bi = -1, bd = Infinity;
    for (let i = 0; i < line.length; i++) { const d = metres(ll, line[i]); if (d < bd) { bd = d; bi = i; } }
    if (bd * physPerLine < 150) out.push({ stop: s, index: bi });
  }
  return out.sort((a, b) => a.index - b.index);
}

// Game-clock minutes to drive along the active route between two line indices.
function gameMinutesAlong(fromIdx: number, toIdx: number) {
  if (!route || toIdx <= fromIdx) return 0;
  const phys = (route.cum[toIdx] - route.cum[fromIdx]) * route.physPerLine;
  const secPerMetre = route.distance > 0 ? route.duration / route.distance : 0.05;
  return (phys * secPerMetre * MAP_SCALE) / 60;
}

// ---- trip plan: when we reach each stop and the destination (game minutes from now)
// Driving time comes from the route model, scaled by `etaCal`, learned from the game's own GPS
// estimate whenever both guide to the same place, so the model drives "like the game". Then the
// time at each stop (fuel, repair, rest) and the waiting at traffic lights / stop signs are added
// (towns run at about 3 game seconds per real second).
let etaCal = 1;
const CITY_TIME_SCALE = 3;
function tripPlan() {
  const prog = routeProgress();
  if (!route || !prog) return null;
  const r = route, from = prog.nearestIndex;
  const e = settings.eta;
  const stayFor = (s: Destination, final: boolean) => final ? 0
    : s.kind === 'fuel' ? e.fuelStopMin : s.kind === 'service' ? e.serviceStopMin : s.kind === 'rest' ? settings.rest.durationMin : e.pointStopMin;
  let t = 0, prev = from, driveMin = 0, waitMin = 0, stopMin = 0, lights = 0, signs = 0;
  const stops: { id: string; name: string; kind: string; n: number; arriveMin: number; stayMin: number }[] = [];
  r.stops.forEach((s, i) => {
    const end = r.stopEnd[i];
    if (end < from) return;   // already passed
    const drive = gameMinutesAlong(prev, end);
    const tl = r.traffic.filter(x => x.idx > prev && x.idx <= end);
    const nL = tl.filter(x => x.type === 'trafficLight').length, nS = tl.length - nL;
    const wait = ((nL * e.lightWaitSec + nS * e.stopSignWaitSec) * CITY_TIME_SCALE) / 60;
    const leg = (drive + wait) * etaCal;
    driveMin += drive * etaCal; waitMin += wait * etaCal; lights += nL; signs += nS;
    t += leg;
    const final = i === r.stops.length - 1;
    const stay = stayFor(s, final);
    stops.push({ id: s.id, name: s.name, kind: s.kind, n: i + 1, arriveMin: t, stayMin: stay });
    t += stay; stopMin += stay;
    prev = end;
  });
  return { stops, totalMin: t - (stops.at(-1)?.stayMin ?? 0), driveMin, waitMin, stopMin, lights, signs, cal: etaCal };
}
// Learn the calibration while heading straight to the destination the game's GPS also guides to.
function calibrateEta() {
  const navTime = tel.ch['truck.navigation.time'];
  if (!route || route.stops.length !== 1 || typeof navTime !== 'number' || navTime <= 0) return;
  const prog = routeProgress();
  if (!prog || prog.offRouteMeters > OFF_ROUTE_M) return;
  const save = etaCal;
  etaCal = 1;
  const ours = tripPlan()?.totalMin ?? 0;
  etaCal = save;
  if (ours < 5) return;
  const ratio = navTime / 60 / ours;
  if (ratio > 0.4 && ratio < 2.5) etaCal = etaCal * 0.9 + ratio * 0.1;   // the game's route may differ: only near-matches, smoothed
}

const stopName = (s: Stop, kind?: StopKind) => {
  const f = s.facilities;
  const base = kind === 'service' || (f.has('service_ico') && !f.has('gas_ico') && !f.has('parking_ico')) ? 'Service station'
    : f.has('gas_ico') ? (f.has('parking_ico') ? 'Fuel + rest stop' : 'Fuel station') : 'Rest area';
  return base + (s.description ? ` (${s.description})` : '');
};

// Vehicle damage (0..1 per part, from the plugin). Transmission and wheels need plugin build ≥ 2026-10-04.
const DAMAGE_PARTS: Record<string, string> = {
  'truck.wear.engine': 'engine', 'truck.wear.transmission': 'transmission', 'truck.wear.cabin': 'body',
  'truck.wear.chassis': 'chassis', 'truck.wear.wheels': 'wheels',
};
function damageInfo() {
  const parts: Record<string, number> = {};
  for (const [ch, name] of Object.entries(DAMAGE_PARTS)) if (typeof tel.ch[ch] === 'number') parts[name] = Math.round(tel.ch[ch] * 1000) / 10;
  const entries = Object.entries(parts);
  if (!entries.length) return null;
  const [worst, max] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
  return { parts, worst, max };   // percentages
}

function clearRoute() { route = null; broadcast({ type: 'route', route: null }); }

function routeForClient() {
  if (!route) return null;
  // each stop is shown at its on-road point (end of its leg), numbered in driving order
  const pub = (s: Destination, i: number) => ({ id: s.id, kind: s.kind, name: s.name, lngLat: route!.line[route!.stopEnd[i]] ?? s.lngLat, n: i + 1, final: i === route!.stops.length - 1 });
  return {
    destination: pub(route.destination, route.stops.length - 1),
    stops: route.stops.map(pub),
    hasJob: !!jobDest, finalIsJob: route.destination.kind === 'job',
    line: route.line, steps: route.steps, distance: route.distance * MAP_SCALE, duration: route.duration * MAP_SCALE,
  };
}

// Haversine-ish distance in metres for small spans.
function metres(a: [number, number], b: [number, number]) {
  const k = Math.PI / 180, dLat = (b[1] - a[1]) * k, dLng = (b[0] - a[0]) * k * Math.cos(((a[1] + b[1]) / 2) * k);
  return Math.sqrt(dLat * dLat + dLng * dLng) * 6371000;
}

// Progress along the active route: nearest vertex, remaining distance, next maneuver.
// Distance from the car to the route *line* (projected onto the nearest segment). Measuring to the
// nearest vertex was wrong on highways, where vertices can be hundreds of metres apart: the car looked
// "off the route" on every long straight and the route was recalculated again and again.
// The search starts around the last match (a full scan only when that fails), and the result is
// cached per telemetry position, so the many callers per update cost one search.
let progCache: { key: string; val: ReturnType<typeof computeProgress> } | null = null;
let lastSeg = 0;
function routeProgress() {
  if (!route) return null;
  const pos = truckLngLat();
  if (!pos) return null;
  const key = `${route.createdAt}|${pos[0]}|${pos[1]}`;
  if (progCache?.key === key) return progCache.val;
  const val = computeProgress(route, pos);
  progCache = { key, val };
  return val;
}
function nearestOnLine(line: [number, number][], pos: [number, number], from: number, to: number) {
  const kx = Math.cos((pos[1] * Math.PI) / 180) * 111320, ky = 110540;
  let bi = from, bt = 0, bd = Infinity;
  for (let i = Math.max(0, from); i < Math.min(line.length - 1, to); i++) {
    const ax = (line[i][0] - pos[0]) * kx, ay = (line[i][1] - pos[1]) * ky;
    const bx = (line[i + 1][0] - pos[0]) * kx, by = (line[i + 1][1] - pos[1]) * ky;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + t * dx, py = ay + t * dy, d = Math.sqrt(px * px + py * py);
    if (d < bd) { bd = d; bi = i; bt = t; }
  }
  return { seg: bi, t: bt, dist: bd };
}
function computeProgress(r: ActiveRoute, pos: [number, number]) {
  const k = r.physPerLine;
  if (r.line.length < 2) return { offRouteMeters: 0, remaining: 0, eta: 0, next: r.steps.length - 1, toNext: 0, nearestIndex: 0 };
  let m = nearestOnLine(r.line, pos, lastSeg - 40, lastSeg + 800);
  if (m.dist * k > 60) m = nearestOnLine(r.line, pos, 0, r.line.length);   // jumped / new route: full scan
  lastSeg = m.seg;
  const segLen = r.cum[m.seg + 1] - r.cum[m.seg];
  const along = r.cum[m.seg] + m.t * segLen;
  const remaining = r.cum[r.cum.length - 1] - along;
  let next = r.steps.length - 1;
  for (let s = 0; s < r.stepStart.length; s++) if (r.stepStart[s] > m.seg) { next = s; break; }
  const toNext = Math.max(0, (r.cum[Math.min(r.stepStart[next] ?? r.line.length - 1, r.line.length - 1)] ?? along) - along);
  // lngLat metres → physical world metres (what the driver sees) via the per-route calibration.
  const remainingPhys = remaining * k;
  const avg = r.distance > 0 ? r.duration / r.distance : 0.05;
  return {
    offRouteMeters: m.dist * k,
    remaining: remainingPhys,          // physical metres
    eta: remainingPhys * avg,          // seconds of driving
    next,
    toNext: toNext * k,                // physical metres to the next maneuver
    nearestIndex: m.seg,
  };
}

// ------------------------------------------------------------------ delivery timing & rest plan

// Delivery windows: the SDK only sends the window END (`delivery.time`). The start ("arrive not
// before", e.g. Sun 4:06 pm) isn't exposed, so the driver enters it once per job in the Job tab.
let earliestByJob: Record<string, number> = readJson<{ map: Record<string, number> }>('job-windows.json', { map: {} }).map;
function jobKey() {
  const j = jobInfo();
  return j ? `${j.companyId}@${j.cityId}@${j.deliveryTime}` : null;
}

// All values in game-clock minutes. `game.time` and the job's `delivery.time` are absolute game minutes.
function deliveryTiming() {
  const j = jobInfo();
  const now = tel.ch['game.time'];
  if (!j || typeof j.deliveryTime !== 'number' || typeof now !== 'number') return null;
  const dueIn = j.deliveryTime - now;
  // ETA: the game's own GPS estimate (navigation.time, game seconds) matches the in-game route advisor
  // exactly; our route estimate is the fallback when the game has no route set.
  let eta: number | null = null, etaSource: 'game' | 'dashlink' | null = null;
  const navTime = tel.ch['truck.navigation.time'], navDist = tel.ch['truck.navigation.distance'];
  const plan = tripPlan();
  const ownStops = !!plan && plan.stops.length > 1;
  // Straight to the job: the game's own GPS estimate is exact. With stops on the way, our plan
  // (driving calibrated to the game's estimate + time at each stop + traffic lights).
  if (!ownStops && typeof navTime === 'number' && navTime > 0 && typeof navDist === 'number' && navDist > 0) { eta = navTime / 60; etaSource = 'game'; }
  // (a destination picked by hand at the job's own company counts as the delivery too)
  else if (plan && (route?.destination.kind === 'job' || (jobDest && route?.destination.nodeUid === jobDest.nodeUid))) { eta = plan.totalMin; etaSource = 'dashlink'; }
  const key = jobKey();
  // Window start: the one entered for this job, else a guess, delivery windows are ~5 h long.
  const set = key && typeof earliestByJob[key] === 'number' ? earliestByJob[key] : null;
  const guessH = Number(settings.delivery.windowHours) || 0;
  const earliest = set ?? (guessH > 0 ? j.deliveryTime - guessH * 60 : null);
  const arrival = eta != null ? now + eta : null;
  // local time zones: where the car is (game clock) and at the destination (deadline / window / arrival)
  const p = tel.ch['truck.world.placement'];
  const here = p ? tzAt(p.pos[0], p.pos[2]) : tzAt(0, 0);
  const destC = [...tsMapData.companies.values()].find(c => c.token === j.companyId && c.cityToken === j.cityId);
  const dest = destC ? tzAt(destC.x, destC.y) : here;
  return {
    now, due: j.deliveryTime, dueIn, eta, etaSource, earliest, earliestGuessed: set == null && earliest != null,
    tz: { here: { shift: here.offset - BASE_TZ_MIN, abbr: here.abbr }, dest: { shift: dest.offset - BASE_TZ_MIN, abbr: dest.abbr } },
    spare: eta != null ? dueIn - eta : null,                                    // >0: time to spare before the window closes
    early: earliest != null && arrival != null && arrival < earliest ? earliest - arrival : null,   // >0: would arrive before the window opens
  };
}

interface RestPlan { type: 'required' | 'spare' | 'wait'; stop: Stop; etaMin: number; detail: string }

// Real-time length of a wait measured in game minutes (the game clock runs `local.scale` x real time).
function realWaitText(gameMin: number) {
  const scale = typeof tel.ch['local.scale'] === 'number' && tel.ch['local.scale'] > 0 ? tel.ch['local.scale'] : 19;
  const sec = Math.round((gameMin * 60) / scale);
  return sec < 90 ? `≈ ${sec} s real time` : `≈ ${Math.round(sec / 60)} min real time`;
}

function restPlan(): RestPlan | null {
  if (!settings.rest.enabled || !settings.rest.planOnRoute || !route || route.stops.some(s => s.kind === 'rest')) return null;
  const prog = routeProgress();
  if (!prog) return null;
  const wantFuel = settings.rest.prefer === 'withFuel';
  const ahead = route.onRoute
    .filter(o => o.index > prog.nearestIndex && o.stop.facilities.has('parking_ico') && (!wantFuel || o.stop.facilities.has('gas_ico')))
    .map(o => ({ ...o, eta: gameMinutesAlong(prog.nearestIndex, o.index) }));
  if (!ahead.length) return null;
  const toEnd = gameMinutesAlong(prog.nearestIndex, route.line.length - 1);
  const restIn = tel.ch['rest.stop'];

  // a) The rest timer runs out before arrival → the last stop we can still reach in time.
  if (typeof restIn === 'number' && restIn >= 0 && restIn < toEnd) {
    const reachable = ahead.filter(o => o.eta <= restIn - 10);
    const pick = reachable.length ? reachable[reachable.length - 1] : ahead[0];
    return { type: 'required', stop: pick.stop, etaMin: pick.eta, detail: `Rest needed in ${fmtMin(restIn)}, last stop before then` };
  }
  const t = deliveryTiming();
  if (!t || route.destination.kind !== 'job') return null;
  const last = ahead[ahead.length - 1];
  const restFits = t.spare != null && t.spare >= settings.rest.durationMin + 30;   // a full rest and still inside the window

  // b) Would arrive BEFORE the delivery window opens.
  if (t.early != null && t.early > 2) {
    if (settings.rest.useSpareTime && restFits)
      return { type: 'spare', stop: last.stop, etaMin: last.eta, detail: `Arriving ${fmtMin(t.early)} before the window opens, rest at the last stop, you still arrive on time` };
    return { type: 'wait', stop: last.stop, etaMin: last.eta, detail: `Arriving ${fmtMin(t.early)} before the window opens, wait ${fmtMin(t.early)} at the last stop (${realWaitText(t.early)}); a full rest would make you late` };
  }
  // c) Plenty of spare time before the window closes → a full rest at the last stop.
  if (settings.rest.useSpareTime && restFits)
    return { type: 'spare', stop: last.stop, etaMin: last.eta, detail: `${fmtMin(t.spare!)} spare, rest at the last stop and still arrive on time` };
  return null;
}

const fmtMin = (m: number) => { const h = Math.floor(m / 60), mm = Math.round(m % 60); return h ? `${h} h ${mm} min` : `${mm} min`; };

// ------------------------------------------------------------------ fuel / rest suggestions

type StopKind = 'fuel' | 'rest' | 'service';
interface Suggestion { id: string; kind: StopKind; reason: string; stop: { name: string; lngLat: [number, number]; facilities: string[]; distance: number; duration: number; detour?: number; detail?: string }; nodeUid: bigint }
let suggestion: Suggestion | null = null;
const dismissedUntil: Record<StopKind, number> = { fuel: 0, rest: 0, service: 0 };
let lastCheck = 0;

const stopFits = (kind: StopKind) => (s: Stop) => {
  const f = s.facilities;
  if (kind === 'service') return f.has('service_ico');
  if (kind === 'fuel') return f.has('gas_ico') && (settings.fuel.prefer !== 'withRest' || f.has('parking_ico'));
  return f.has('parking_ico') && (settings.rest.prefer !== 'withFuel' || f.has('gas_ico'));
};

// The station that costs the least extra driving.
// On a route: every suitable station near the rest of the route is measured by how far it lies off
// the route; the closest few are routed for real (car → station → next stop vs. staying on the
// route) and the smallest detour wins. Fuel stations must be reachable with the fuel left, rest
// stops before the rest timer runs out. Without a route: the station with the shortest drive.
async function bestStop(kind: StopKind): Promise<Suggestion['stop'] & { nodeUid: bigint } | null> {
  const pos = truckLngLat();
  const truck = truckState();
  if (!pos || !truck) return null;
  const ok = stopFits(kind);
  const ctx = { graphAndMapData: gm as never, routing: routing as never, truck: truck as never, domainEventSink: quietSink as never };
  const show = (s: Stop, distPhys: number, durSec: number, detourSec?: number) => ({
    name: stopName(s, kind), lngLat: toLngLat(s.x, s.y), facilities: [...s.facilities],
    distance: distPhys * MAP_SCALE, duration: durSec * MAP_SCALE, detour: detourSec != null ? detourSec * MAP_SCALE : undefined, nodeUid: s.nodeUid,
  });

  const prog = routeProgress();
  if (route && prog) {
    const r = route, from = prog.nearestIndex;
    const secPerPhys = r.distance > 0 ? r.duration / r.distance : 0.05;
    const rangePhys = typeof tel.ch['truck.fuel.range'] === 'number' ? (tel.ch['truck.fuel.range'] * 1000) / MAP_SCALE : Infinity;
    const restIn = tel.ch['rest.stop'];
    // bounding box of the route still ahead
    let [minLng, minLat, maxLng, maxLat] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = from; i < r.line.length; i++) { const [lng, lat] = r.line[i]; minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng); minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat); }
    const pad = 0.25;
    const cands: { s: Stop; idx: number; off: number; along: number; est: number }[] = [];
    for (const s of stops) {
      if (!ok(s)) continue;
      const ll = toLngLat(s.x, s.y);
      if (ll[0] < minLng - pad || ll[0] > maxLng + pad || ll[1] < minLat - pad || ll[1] > maxLat + pad) continue;
      let bi = from, bd = Infinity;
      for (let i = from; i < r.line.length; i += 2) { const d = metres(ll, r.line[i]); if (d < bd) { bd = d; bi = i; } }
      const off = bd * r.physPerLine, along = (r.cum[bi] - r.cum[from]) * r.physPerLine;
      if (kind === 'fuel' && along + off > rangePhys * 0.85) continue;                      // must reach it on the fuel left
      if (kind === 'rest' && typeof restIn === 'number' && restIn >= 0 && gameMinutesAlong(from, bi) > restIn - 5) continue;
      cands.push({ s, idx: bi, off, along, est: 2 * off * secPerPhys + along * secPerPhys * 0.02 });
    }
    cands.sort((a, b) => a.est - b.est);
    let best: { c: typeof cands[number]; toSec: number; toPhys: number; detour: number } | null = null;
    for (const c of cands.slice(0, 5)) {
      try {
        const toStop = (await generateRoutes(c.s.nodeUid, [settings.routeMode], ctx))[0];
        if (!toStop) continue;
        let detour = 2 * c.off * secPerPhys;   // estimate: off the route and back
        // station on the current leg: exact extra time = car→station→next stop − car→next stop
        if (c.idx <= r.stopEnd[0]) {
          const onward = await legFrom(toStop, r.stops[0].nodeUid);
          if (onward) detour = Math.max(0, toStop.duration + onward.duration - (r.cum[r.stopEnd[0]] - r.cum[from]) * r.physPerLine * secPerPhys);
        }
        const score = detour + c.along * secPerPhys * 0.02;
        if (!best || score < best.detour + best.c.along * secPerPhys * 0.02) best = { c, toSec: toStop.duration, toPhys: toStop.distanceMeters, detour };
      } catch { /* unreachable candidate */ }
    }
    if (best) return show(best.c.s, best.toPhys, best.toSec, best.detour);
  }

  // no route (or nothing suitable near it): shortest drive from here
  const [x, y] = fromWgs84ToAtsCoords(pos);
  const near = stops.filter(ok).map(s => ({ s, d: Math.hypot(s.x - x, s.y - y) })).sort((a, b) => a.d - b.d).slice(0, 5);
  let best: ReturnType<typeof show> | null = null;
  for (const { s } of near) {
    try {
      const r = (await generateRoutes(s.nodeUid, [settings.routeMode], ctx))[0];
      if (r && (!best || r.duration * MAP_SCALE < best.duration)) best = show(s, r.distanceMeters, r.duration);
    } catch { /* unreachable candidate */ }
  }
  return best;
}

// Reached a fuel / rest / mechanic stop: the stop's map point is its entrance, so the pumps or the
// parking are still a few minutes away, no new suggestion of that kind for a while (it used to
// suggest the same need again while you were pulling in).
const QUIET_AFTER_STOP_MS = 30 * 60 * 1000;
function quietAfterStop(kind: Destination['kind']) {
  if (kind === 'fuel' || kind === 'rest' || kind === 'service') dismissedUntil[kind] = Math.max(dismissedUntil[kind], Date.now() + QUIET_AFTER_STOP_MS);
}

async function suggest(kind: StopKind, reason: string, now: number) {
  const stop = await bestStop(kind);
  if (!stop) { log(`need ${kind} (${reason}) but no reachable stop found`); return false; }
  const { nodeUid, ...shown } = stop;
  suggestion = { id: String(now), kind, reason, stop: shown, nodeUid };
  log(`suggest ${kind}: ${shown.name} ${(shown.distance / 1609).toFixed(1)} game mi${shown.detour != null ? `, detour ${fmtMin(shown.detour / 60)}` : ''}`);
  if (settings.voice.suggestions) {
    const extra = shown.detour != null && route ? (shown.detour < 90 ? 'on your way' : `about ${Math.max(1, Math.round(shown.detour / 60))} minutes extra`) : '';
    const what = { fuel: 'A fuel station', rest: 'A rest area', service: 'A service station' }[kind];
    say(`${reason.replace(/\. .*$/, '').replace(/%/g, ' percent')}. ${what}${extra ? `, ${extra}` : ''}, ${settings.suggestions === 'auto' ? 'has been added to your route' : 'tap Add to route to go there'}.`);
  }
  if (settings.suggestions === 'auto') await acceptSuggestion();
  else broadcast({ type: 'suggestion', suggestion: { ...suggestion, nodeUid: undefined } });
  return true;
}

// Every few seconds: is fuel low, the car damaged or a rest due? The answer is a suggested stop that
// joins the route as one more point (accepted automatically when suggestions = auto).
async function checkNeeds() {
  if (settings.suggestions === 'off' || suggestion || routing_busy || !pluginConnected || tel.paused) return;
  if (placeHere()) return;   // standing at a company / pump / garage / parking: you're already there
  const heading = (k: Destination['kind']) => !!route?.stops.some(s => s.kind === k);   // already going to one
  const now = Date.now();
  const fp = fuelPct();
  const restMin = tel.ch['rest.stop'];

  if (settings.fuel.enabled && fp != null && fp <= settings.fuel.thresholdPct && now > dismissedUntil.fuel && !heading('fuel')) {
    if (await suggest('fuel', `Fuel at ${Math.round(fp)}%`, now)) return;
  }
  const dmg = damageInfo();
  if (settings.damage.enabled && dmg && dmg.max >= settings.damage.thresholdPct && now > dismissedUntil.service && !heading('service')) {
    if (await suggest('service', `Damage ${Math.round(dmg.max)}% (${dmg.worst}). Get it repaired`, now)) return;
  }
  if (heading('rest')) return;
  // Route-aware rest plan: ask when the planned stop is within the warning window.
  const plan = restPlan();
  if (plan && plan.etaMin <= settings.rest.thresholdMin && now > dismissedUntil.rest) {
    const prog = routeProgress();
    const o = route!.onRoute.find(x => x.stop === plan.stop);
    const physToStop = prog && o ? (route!.cum[o.index] - route!.cum[prog.nearestIndex]) * route!.physPerLine : 0;
    suggestion = {
      id: String(now), kind: 'rest',
      reason: plan.type === 'required' ? 'Rest stop on your route' : plan.type === 'wait' ? 'Too early: wait at the last stop' : 'Use your spare time to rest',
      stop: { name: stopName(plan.stop), lngLat: toLngLat(plan.stop.x, plan.stop.y), facilities: [...plan.stop.facilities], distance: physToStop * MAP_SCALE, duration: plan.etaMin * 60, detour: 0, detail: plan.detail },
      nodeUid: plan.stop.nodeUid,
    };
    log(`suggest rest (${plan.type}): ${stopName(plan.stop)} in ${fmtMin(plan.etaMin)}`);
    if (settings.suggestions === 'auto') await acceptSuggestion();
    else broadcast({ type: 'suggestion', suggestion: { ...suggestion, nodeUid: undefined } });
    return;
  }
  // Without a route plan (no route, or no rest stops on it): the rest stop with the least detour.
  if (!plan && settings.rest.enabled && typeof restMin === 'number' && restMin >= 0 && restMin <= settings.rest.thresholdMin && now > dismissedUntil.rest) {
    await suggest('rest', `Rest needed in ${fmtMin(restMin)}`, now);
  }
}

async function acceptSuggestion() {
  if (!suggestion) return;
  const s = suggestion;
  suggestion = null;
  broadcast({ type: 'suggestion', suggestion: null });
  // the stop joins the plan like any other stop; the route then continues to the final destination
  waypoints.push({ id: newId(), kind: s.kind, name: s.stop.name.replace(/ · on your route$/, ''), nodeUid: s.nodeUid, lngLat: s.stop.lngLat });
  await replan();
}

// ------------------------------------------------------------------ job → destination

function jobInfo() {
  const j = tel.cfg.car_job && Object.keys(tel.cfg.car_job).length ? tel.cfg.car_job : tel.cfg.job;
  if (!j || !Object.keys(j).length) return null;
  const destCity = cities.get(j['destination.city.id']);
  return {
    cargo: j['cargo'] ?? j['cargo.id'],
    from: `${j['source.company'] ?? ''}, ${j['source.city'] ?? ''}`,
    to: `${j['destination.company'] ?? companyNames.get(j['destination.company.id']) ?? j['destination.company.id']}, ${j['destination.city'] ?? destCity?.name ?? ''}`,
    income: j['income'],
    plannedKm: j['planned_distance.km'],
    // cargo damage 0..100 % (plugin build ≥ 2026-10-04)
    cargoDamage: typeof tel.ch['job.cargo.damage'] === 'number' ? Math.round(tel.ch['job.cargo.damage'] * 1000) / 10 : null,
    cargoMass: j['cargo.mass'],
    deliveryTime: j['delivery.time'],
    market: j['job.market'] ?? j['car_job.market'],
    special: j['is.special.job'],
    companyId: j['destination.company.id'] as string,
    cityId: j['destination.city.id'] as string,
    sourceCompanyId: j['source.company.id'] as string | undefined,
    sourceCityId: j['source.city.id'] as string | undefined,
  };
}

// ---- what the car is stopped at (for the on-screen "Enter" button)
// The game's "press Enter" prompts sit on exact spots inside prefabs: unload / trailer spots and the
// company point in depots, pumps at fuel stations, the garage at service stations and the parking
// triggers where you can sleep. Their positions come from the prefab descriptions (local coordinates
// turned into world positions once at startup). The app shows the button only when the car stands
// on or right next to such a spot. Refuelling and sleeping need the engine off (the game requires it).
type SpotKind = 'company' | 'fuel' | 'service' | 'sleep';
interface Spot { x: number; y: number; kind: SpotKind; prefabUid: bigint; dlcGuard: number }
const SPOT_RADIUS_M: Record<SpotKind, number> = { company: 30, fuel: 12, service: 20, sleep: 20 };
const COMPANY_SPAWNS = new Set([1, 2, 9, 13, 19, 20, 21, 23, 25]);   // trailer / unload / company points
const companyByPrefab = new Map<bigint, { token: string; cityToken: string }>();
for (const c of tsMapData.companies.values()) companyByPrefab.set(c.prefabUid, c);
const spots: Spot[] = [];
for (const pf of tsMapData.prefabs.values()) {
  const desc = tsMapData.prefabDescriptions.get(pf.token) as (PrefabDescription & { spawnPoints?: { x: number; y: number; type: number }[]; triggerPoints?: { x: number; y: number; action: string }[] }) | undefined;
  if (!desc) continue;
  const isCompany = companyByPrefab.has(pf.uid);
  const add = (pt: { x: number; y: number }, kind: SpotKind) => {
    try {
      const [x, y] = toMapPosition([pt.x, pt.y], pf, desc, tsMapData.nodes);
      spots.push({ x, y, kind, prefabUid: pf.uid, dlcGuard: pf.dlcGuard });
    } catch { /* prefab with missing nodes */ }
  };
  for (const s of desc.spawnPoints ?? []) {
    if (s.type === 3) add(s, 'fuel');
    else if (s.type === 4) add(s, 'service');
    else if (isCompany && COMPANY_SPAWNS.has(s.type)) add(s, 'company');
  }
  for (const t of desc.triggerPoints ?? []) if (t.action === 'hud_parking' || t.action === 'parking_car') add(t, isCompany ? 'company' : 'sleep');
}
log(`action spots: ${spots.length} (${(['company', 'fuel', 'service', 'sleep'] as SpotKind[]).map(k => `${k} ${spots.filter(s => s.kind === k).length}`).join(', ')})`);

function placeHere() {
  if (!settings.actionPrompt.enabled || !pluginConnected || tel.paused) return null;
  const p = tel.ch['truck.world.placement'];
  if (!p || Math.abs(tel.ch['truck.speed'] ?? 0) > 1.5) return null;
  const [x, y] = [p.pos[0], p.pos[2]];
  const engineOn = !!tel.ch['truck.engine.enabled'];
  // the closest spot relative to its size wins (a pump right next to a parking trigger: the pump)
  let best: { s: Spot; score: number } | null = null;
  for (const s of spots) {
    const d = Math.hypot(s.x - x, s.y - y);
    if (d > SPOT_RADIUS_M[s.kind] || !guardOk(s.dlcGuard)) continue;
    const score = d / SPOT_RADIUS_M[s.kind];
    if (!best || score < best.score) best = { s, score };
  }
  if (!best) return null;
  const s = best.s;
  if (s.kind === 'company') {
    const c = companyByPrefab.get(s.prefabUid)!;
    const j = jobInfo();
    const name = `${companyNames.get(c.token) ?? c.token}, ${cities.get(c.cityToken)?.name ?? c.cityToken}`;
    const isDest = !!j && c.token === j.companyId && c.cityToken === j.cityId;
    const isSource = !!j && c.token === j.sourceCompanyId && c.cityToken === j.sourceCityId;
    return { kind: 'company', name, action: isDest ? 'Deliver cargo' : isSource ? 'Load cargo' : 'Company', needEngineOff: false, engineOn, jobPlace: isDest || isSource };
  }
  // name the station after the nearest service area
  let near: Stop | null = null, nd = 600;
  for (const st of stops) { const d = Math.hypot(st.x - x, st.y - y); if (d < nd) { nd = d; near = st; } }
  const kind = s.kind === 'sleep' ? 'rest' : s.kind;
  return {
    kind, name: near ? stopName(near) : { fuel: 'Fuel station', service: 'Service station', rest: 'Parking' }[kind]!,
    action: { fuel: 'Refuel', service: 'Repair', rest: 'Sleep' }[kind]!,
    needEngineOff: kind !== 'service', engineOn, jobPlace: false,
  };
}

function onJobChange() {
  const j = jobInfo();
  const key = j ? `${j.companyId}@${j.cityId}` : '';
  if (key === lastJobKey) return;
  lastJobKey = key;
  jobRouteOff = false;
  if (!j) { jobDest = null; void replan(); return; }   // job finished / cancelled: own stops stay
  const company = [...tsMapData.companies.values()].find(c => c.token === j.companyId && c.cityToken === j.cityId && graphData.graph.has(c.nodeUid));
  if (!company) { log('job destination not routable', key); jobDest = null; return; }
  jobDest = { id: 'job', kind: 'job', name: j.to, nodeUid: company.nodeUid, lngLat: toLngLat(company.x, company.y) };
  void replan();
}

// ------------------------------------------------------------------ voice guidance
// Co-Driver speaks its own route (the game's GPS voice can't follow Co-Driver stops). Phrases are made
// here and spoken either on the PC (Windows voice, mixed with the game sound in your headset) or on
// the dashboards (each device's own voice), settings.voice.output.

// PC voice. Two engines:
//  - Piper (tools\piper): natural neural voices, offline. A Piper process stays running; each line of
//    text becomes a .wav, which is played through the default sound device (your headset).
//  - Windows voices (System.Speech, e.g. Zira) as the fallback.
// One long-running PowerShell does the Windows speech and plays Piper's .wav files.
let pcTts: ChildProcess | null = null;
const PC_TTS_SCRIPT = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$sp = New-Object System.Media.SoundPlayer
[Console]::InputEncoding = [Text.Encoding]::UTF8
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    $m = $line | ConvertFrom-Json
    if ($m.cmd -eq 'voices') { ($s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }) -join '|' | Write-Output; continue }
    if ($m.cmd -eq 'play') { $s.SpeakAsyncCancelAll(); $sp.Stop(); $sp.SoundLocation = [string]$m.file; $sp.Load(); $sp.Play(); continue }
    if ($m.cmd -eq 'stop') { $s.SpeakAsyncCancelAll(); $sp.Stop(); continue }
    if ($m.voice) { try { $s.SelectVoice($m.voice) } catch {} }
    $s.Rate = [int]$m.rate; $s.Volume = [int]$m.volume
    if ($m.urgent) { $s.SpeakAsyncCancelAll(); $sp.Stop() }
    [void]$s.SpeakAsync([string]$m.text)
  } catch {}
}`;
let windowsVoices: string[] = [];
function pcTtsProc() {
  if (pcTts && pcTts.exitCode == null) return pcTts;
  pcTts = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PC_TTS_SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  pcTts.stdout?.on('data', (d: Buffer) => { const t = d.toString('utf8').trim(); if (t) windowsVoices = t.split('|').filter(Boolean); });
  pcTts.on('exit', () => { pcTts = null; });
  pcTts.stdin?.write(JSON.stringify({ cmd: 'voices' }) + '\n');
  return pcTts;
}
pcTtsProc();
const pcSend = (m: unknown) => pcTtsProc().stdin?.write(JSON.stringify(m) + '\n');

// ---- Piper
// voice engine ships with the program; voice models are downloaded into the user's folder
const PIPER_DIR = path.join(HOME, 'voice');
const PIPER_EXE = process.env.CODRIVER_PIPER_EXE ?? path.join(PROGRAM_DIR, 'piper', 'piper.exe');
const PIPER_OUT = path.join(os.tmpdir(), 'ats-codriver-voice');
fs.mkdirSync(PIPER_OUT, { recursive: true });
function piperModels(): string[] {
  try { return fs.existsSync(PIPER_EXE) ? fs.readdirSync(PIPER_DIR).filter(f => f.endsWith('.onnx')).map(f => f.replace(/\.onnx$/, '')) : []; } catch { return []; }
}
// voice list for Settings: Piper voices first ("Piper: en_US-amy-medium"), then Windows voices
const allPcVoices = () => [...piperModels().map(m => 'Piper: ' + m), ...windowsVoices];
// '' = best available: the first Piper voice, else the default Windows voice
function pcVoiceChoice(): { piper?: string; windows?: string } {
  const v = settings.voice.pcVoice;
  if (v.startsWith('Piper: ') && piperModels().includes(v.slice(7))) return { piper: v.slice(7) };
  if (v && !v.startsWith('Piper: ')) return { windows: v };
  const first = piperModels()[0];
  return first ? { piper: first } : {};
}
let piper: { proc: ChildProcess; model: string; lengthScale: number; waiting: ((file: string) => void)[]; buf: string } | null = null;
function piperProc(model: string, lengthScale: number) {
  if (piper && piper.model === model && piper.lengthScale === lengthScale && piper.proc.exitCode == null) return piper;
  piper?.proc.kill();
  const proc = spawn(PIPER_EXE, ['--model', path.join(PIPER_DIR, model + '.onnx'), '--output_dir', PIPER_OUT, '--length_scale', String(lengthScale), '--quiet'],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, cwd: path.dirname(PIPER_EXE) });
  const p = { proc, model, lengthScale, waiting: [] as ((file: string) => void)[], buf: '' };
  // Piper prints the path of every finished .wav on its own line
  proc.stdout?.on('data', (d: Buffer) => {
    p.buf += d.toString('utf8');
    let i;
    while ((i = p.buf.indexOf('\n')) >= 0) {
      const file = p.buf.slice(0, i).trim();
      p.buf = p.buf.slice(i + 1);
      if (file.endsWith('.wav')) p.waiting.shift()?.(file);
    }
  });
  proc.on('exit', () => { if (piper === p) piper = null; for (const w of p.waiting) w(''); });
  piper = p;
  return p;
}
function piperSynth(text: string, model: string, lengthScale: number): Promise<string> {
  const p = piperProc(model, lengthScale);
  return new Promise(res => { p.waiting.push(res); p.proc.stdin?.write(text.replace(/\s+/g, ' ') + '\n'); });
}
// volume: scale the 16-bit samples of the .wav; returns its duration in ms
function wavPrepare(file: string, volumePct: number) {
  const buf = fs.readFileSync(file);
  let off = 12, dataAt = -1, dataLen = 0, byteRate = 44100;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), len = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(off + 16);
    if (id === 'data') { dataAt = off + 8; dataLen = Math.min(len, buf.length - dataAt); break; }
    off += 8 + len;
  }
  if (dataAt < 0) return 0;
  const k = Math.max(0, Math.min(1.5, volumePct / 100));
  if (k !== 1) {
    for (let i = dataAt; i + 1 < dataAt + dataLen; i += 2) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(buf.readInt16LE(i) * k))), i);
    fs.writeFileSync(file, buf);
  }
  return (dataLen / byteRate) * 1000;
}
// play queue: messages wait for the one being spoken; urgent ones cut in
let playingUntil = 0, playQueue: string[] = [], playTimer: NodeJS.Timeout | undefined;
function playWav(file: string) {
  const ms = wavPrepare(file, settings.voice.volume);
  pcSend({ cmd: 'play', file });
  playingUntil = Date.now() + ms;
  clearTimeout(playTimer);
  playTimer = setTimeout(() => { const next = playQueue.shift(); if (next) playWav(next); }, ms + 250);
  setTimeout(() => fs.rm(file, { force: true }, () => {}), ms + 15000);
}
let sayGen = 0;
async function sayPiper(text: string, urgent: boolean, model: string) {
  const gen = urgent ? ++sayGen : sayGen;
  const lengthScale = Math.round((1 - settings.voice.rate * 0.04) * 100) / 100;   // rate 0 = normal, +10 ≈ 1.7× faster
  const file = await piperSynth(text, model, lengthScale);
  if (!file) return;
  if (gen !== sayGen) return;   // a newer urgent message superseded this one
  if (urgent) { playQueue = []; playWav(file); }
  else if (Date.now() < playingUntil) playQueue.push(file);
  else playWav(file);
}

// Say something. urgent = cuts off whatever is being said (a turn right now beats an old hint).
function say(text: string, urgent = false) {
  const v = settings.voice;
  if (v.output === 'off' || !text) return;
  log('voice:', text);
  if (v.output === 'pc') {
    const c = pcVoiceChoice();
    if (c.piper) void sayPiper(text, urgent, c.piper);
    else pcSend({ text, urgent, rate: v.rate, volume: v.volume, voice: c.windows });
  } else {
    broadcast({ type: 'say', text, urgent, rate: v.rate, volume: v.volume });
  }
}

// ---- phrases
function spokenDistance(m: number) {
  if (settings.units === 'metric') {
    if (m < 950) { const r = m < 300 ? 50 : 100; return `${Math.max(r, Math.round(m / r) * r)} metres`; }
    const km = Math.round(m / 500) / 2;
    return km === 1 ? '1 kilometre' : `${km} kilometres`;
  }
  const ft = m * 3.28084, mi = m / 1609.34;
  if (mi < 0.18) { const r = ft < 600 ? 50 : 100; return `${Math.max(r, Math.round(ft / r) * r)} feet`; }
  if (mi < 0.35) return 'a quarter mile';
  if (mi < 0.65) return 'half a mile';
  if (mi < 0.85) return 'three quarters of a mile';
  const r = Math.round(mi * 2) / 2;
  return r === 1 ? '1 mile' : `${r} miles`;
}
// road signs as they would be said: "I-5 N" → "I 5 North"
function spokenSign(t?: string) {
  if (!t) return '';
  return t.replace(/\s*·\s*/g, ', ').replace(/\b(I|US|SR|CA|NV|AZ|TX)-(\d+)/g, '$1 $2')
    .replace(/(\d+)\s?([NSEW])\b/g, (_m, n, d) => `${n} ${{ N: 'North', S: 'South', E: 'East', W: 'West' }[d as 'N']}`);
}
const ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
function spokenTurn(d: number, exit?: number) {
  if (d >= 21 && d <= 28) return `at the roundabout, take the ${ORD[exit ?? 0] || (exit ? exit + 'th' : 'next')} exit`;
  return ({ 0: 'continue straight', 1: 'keep left', 2: 'turn left', 3: 'turn sharply left', 4: 'make a U-turn', 11: 'keep right', 12: 'turn right', 13: 'turn sharply right', 14: 'make a U-turn', 29: 'exit the roundabout', [-1]: 'merge', [-3]: 'you will arrive at your destination', [-4]: 'take the ferry' } as Record<number, string>)[d] ?? 'continue';
}
// "use the two right lanes" from the lane hint (active = lanes leading your way)
function spokenLanes(lanes?: { branches: number[]; active?: number }[]) {
  if (!lanes || lanes.length < 2) return '';
  const act = lanes.map((l, i) => (l.active != null ? i : -1)).filter(i => i >= 0);
  if (!act.length || act.length === lanes.length) return '';
  const n = act.length, num = ['', 'the', 'the two', 'the three', 'the four'][n] ?? `${n}`;
  const lane = n === 1 ? 'lane' : 'lanes';
  if (act[0] === 0) return `use ${num} left ${lane}`;
  if (act[n - 1] === lanes.length - 1) return `use ${num} right ${lane}`;
  return `use ${num} middle ${lane}`;
}

// ---- when to speak: few, well-timed calls (the screen shows the rest)
//   highway (> ~65 km/h): one early call ~2 km before (with lanes), one ~6 s before ("in 200 m …")
//   town:                 one call ~8 s before ("in 100 m, turn left")
// Lane splits where you just continue, and merges, are not spoken. Two maneuvers close together
// are said as one sentence ("…, then turn left") and the second isn't announced early again.
const spoken = new Set<string>();
let spokenRoute = 0, lastSpokenAt = 0;
function voiceTick(prog: NonNullable<ReturnType<typeof routeProgress>>) {
  if (!route || settings.voice.output === 'off' || !settings.voice.guidance) return;
  if (route.createdAt !== spokenRoute) { spokenRoute = route.createdAt; spoken.clear(); }
  if (offRouteSince) return;
  const step = route.steps[prog.next];
  if (!step) return;
  const d = Number(step.direction);
  if (d === 0 || d === -1 || d === -2) return;           // continue straight / merge / depart: nothing to say
  const speed = Math.max(Math.abs(tel.ch['truck.speed'] ?? 0), 3);
  const highway = speed > 18;
  const key = (stage: string) => `${prog.next}:${stage}`;
  const after = route.steps[prog.next + 1];
  const chained = !!after && step.distance < 300 && ![0, -1, -2].includes(Number(after.direction));
  const thenTxt = chained ? `, then ${spokenTurn(Number(after!.direction), after!.exit)}` : '';
  const isArrive = d === -3;
  const what = isArrive ? (prog.next < route.steps.length - 1 ? `you will reach your stop, ${step.banner?.replace(/^Stop \d+: /, '')}` : `you will arrive at ${step.banner ?? 'your destination'}`) : spokenTurn(d, step.exit);
  const onto = !isArrive && step.banner ? ` towards ${spokenSign(step.banner)}` : '';
  const laneHint = spokenLanes(step.lanes);
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
  const finalAt = highway ? Math.max(120, speed * 6) : Math.max(50, speed * 8);
  const earlyAt = settings.voice.earlyM ?? 2000;

  if (prog.toNext <= finalAt) {
    if (spoken.has(key('final'))) return;
    spoken.add(key('final')); spoken.add(key('early'));
    if (chained) { spoken.add(`${prog.next + 1}:early`); if (after!.distance < 150) spoken.add(`${prog.next + 1}:final`); }
    say(`In ${spokenDistance(prog.toNext)}, ${what}${!highway ? onto : ''}${thenTxt}.`, true);
    lastSpokenAt = Date.now();
  } else if (highway && prog.toNext <= earlyAt && prog.toNext > Math.max(700, finalAt * 3)) {
    if (spoken.has(key('early')) || Date.now() - lastSpokenAt < 5000) return;
    spoken.add(key('early'));
    say(`In ${spokenDistance(prog.toNext)}, ${what}${onto}${laneHint ? `. ${cap(laneHint)}` : ''}.`);
    lastSpokenAt = Date.now();
  }
}

// ------------------------------------------------------------------ per-telemetry-frame work

function onTelemetry() {
  onJobChange();
  const prog = routeProgress();
  if (route && prog) {
    // passed an intermediate stop? (driving past within ~80 m counts, no need to stop)
    if (route.stops.length > 1 && !routing_busy) {
      const end0 = route.stopEnd[0];
      const pos = truckLngLat();
      if (pos && prog.nearestIndex >= end0 - 1 && metres(pos, route.line[end0]) * route.physPerLine < 80) {
        const s = route.stops[0];
        log('reached stop', s.name);
        broadcast({ type: 'arrived', name: s.name, stop: true });
        quietAfterStop(s.kind);
        if (settings.voice.stops) say(`Stop reached: ${s.name}.`);
        waypoints = waypoints.filter(w => w.id !== s.id);
        void replan();
      }
    }
    // arrived at the final destination?
    if (route.stops.length === 1 && prog.remaining < 40 && Math.abs(tel.ch['truck.speed'] ?? 0) < 1) {
      if (settings.voice.stops && !spoken.has('arrived')) { spoken.add('arrived'); say(`You have arrived at ${route.destination.name}.`); }
      arrivedSince ||= Date.now();
      if (Date.now() - arrivedSince > 8000) {
        const d = route.destination;
        log('arrived at', d.name);
        broadcast({ type: 'arrived', name: d.name });
        quietAfterStop(d.kind);
        arrivedSince = 0;
        waypoints = waypoints.filter(w => w.id !== d.id);
        if (finalDest?.id === d.id) finalDest = null;
        if (d.kind === 'job') jobRouteOff = true;   // at the company: nothing left to guide to
        // an own destination reached during a job → the route continues to the job
        void replan();
      }
    } else arrivedSince = 0;
    // off route → reroute after 4 s (stops are re-ordered from the new position)
    if (prog.offRouteMeters > OFF_ROUTE_M && Math.abs(tel.ch['truck.speed'] ?? 0) > 2) {
      offRouteSince ||= Date.now();
      if (Date.now() - offRouteSince > 4000 && !routing_busy && Date.now() - lastReroute > REROUTE_COOLDOWN_MS) {
        offRouteSince = 0; lastReroute = Date.now();
        log('off route, recalculating');
        if (settings.voice.guidance) say('Recalculating.', true);
        void replan();
      }
    } else offRouteSince = 0;
    voiceTick(prog);
  }
  if (Date.now() - lastCheck > 5000) { lastCheck = Date.now(); calibrateEta(); void checkNeeds(); }
}

// ------------------------------------------------------------------ dashboards (HTTP + WS)

const clients = new Set<WebSocket>();
function broadcast(msg: unknown) {
  const s = JSON.stringify(msg, (_k, v) => (typeof v === 'bigint' ? v.toString(16) : v));
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s);
}

function snapshot() {
  const prog = routeProgress();
  return {
    type: 'state',
    connected: pluginConnected,
    game: tel.game,
    paused: tel.paused,
    ch: tel.ch,
    truck: tel.cfg.truck ?? {},
    job: jobInfo(),
    lngLat: truckLngLat(),
    fuelPct: fuelPct(),
    damage: damageInfo(),
    // local time where the car is (the in-game clock shows local time)
    clockTz: (() => { const p = tel.ch['truck.world.placement']; const z = p ? tzAt(p.pos[0], p.pos[2]) : null; return z ? { shift: z.offset - BASE_TZ_MIN, abbr: z.abbr } : null; })(),
    plan: tripPlan(),
    here: placeHere(),
    // remaining → game miles; eta → game-clock seconds (the game clock runs ~20x real time), matching
    // the in-game route advisor. offRoute only while actually driving away from the line.
    nav: prog && route ? { remaining: prog.remaining * MAP_SCALE, eta: prog.eta * MAP_SCALE, next: route.steps[prog.next], after: route.steps[prog.next + 1], nextIndex: prog.next, toNext: prog.toNext, offRoute: offRouteSince > 0, progressIndex: prog.nearestIndex, progress: tripProgress(prog) } : null,
    jobProgress: jobProgress(prog),
    events: tel.events.slice(-5),
    timing: deliveryTiming(),
    restPlan: (() => { const p = restPlan(); return p ? { type: p.type, name: stopName(p.stop), etaMin: p.etaMin, detail: p.detail, lngLat: toLngLat(p.stop.x, p.stop.y) } : null; })(),
  };
}
setInterval(() => broadcast(snapshot()), 100);   // 10 Hz: gauges, cards, navigation
// The car's position goes out on every plugin update (~60/s) as a tiny separate message, so the map
// can move smoothly without sending the whole dashboard state that often.
let lastPosKey = '';
function sendPosition() {
  const p = tel.ch['truck.world.placement'];
  if (!p || !clients.size) return;
  const lngLat = toLngLat(p.pos[0], p.pos[2]);
  const key = `${lngLat[0]},${lngLat[1]},${p.rot[0]}`;
  if (key === lastPosKey) return;   // game frame not advanced (paused / same frame)
  lastPosKey = key;
  broadcast({ type: 'pos', p: lngLat, h: p.rot[0], v: tel.ch['truck.speed'] ?? 0 });
}

// ---- progress bars (0..1)
// Trip: share of the way to the final destination already driven. The total is remembered per
// destination, so reroutes and added stops don't restart the bar (a longer route only stretches it).
let tripStart: { finalId: string; total: number } | null = null;
function tripProgress(prog: NonNullable<ReturnType<typeof routeProgress>>) {
  if (!route) return null;
  const id = route.destination.id + '|' + route.destination.name;
  if (!tripStart || tripStart.finalId !== id) tripStart = { finalId: id, total: prog.remaining };
  tripStart.total = Math.max(tripStart.total, prog.remaining);
  return tripStart.total > 0 ? Math.max(0, Math.min(1, 1 - prog.remaining / tripStart.total)) : 1;
}
// Delivery: driven share of the job's planned distance (stays on the delivery card for the whole
// job, also without a Co-Driver route, then the game's own GPS distance is used).
function jobProgress(prog: ReturnType<typeof routeProgress>) {
  const j = jobInfo();
  if (!j?.plannedKm) return null;
  const planned = j.plannedKm * 1000;                                      // game metres
  let left: number | null = null;
  if (route && prog && route.destination.kind === 'job') left = prog.remaining * MAP_SCALE;
  else if (typeof tel.ch['truck.navigation.distance'] === 'number' && tel.ch['truck.navigation.distance'] > 0) left = tel.ch['truck.navigation.distance'];
  if (left == null) return null;
  return { value: Math.max(0, Math.min(1, 1 - left / planned)), leftM: left, plannedM: planned };
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
function sendFile(res: http.ServerResponse, file: string) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}
function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString(16) : v)));
}
async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

function search(q: string) {
  q = q.trim().toLowerCase();
  if (q.length < 2) return [];
  const out: { kind: string; name: string; detail: string; lngLat: [number, number] }[] = [];
  for (const c of cities.values()) if (guardOk(c.dlcGuard) && c.name.toLowerCase().includes(q)) out.push({ kind: 'city', name: c.name, detail: c.state, lngLat: toLngLat(c.x, c.y) });
  for (const c of tsMapData.companies.values()) {
    if (!usableNodes.has(c.nodeUid)) continue;   // company in a state you don't own
    const name = companyNames.get(c.token) ?? c.token;
    const city = cities.get(c.cityToken);
    if (name.toLowerCase().includes(q) || (city && `${name} ${city.name}`.toLowerCase().includes(q))) out.push({ kind: 'company', name, detail: city?.name ?? c.cityToken, lngLat: toLngLat(c.x, c.y) });
    if (out.length > 60) break;
  }
  for (const f of favourites) if (f.name.toLowerCase().includes(q)) out.unshift({ kind: 'favourite', name: f.name, detail: 'Favourite', lngLat: f.lngLat });
  return out.slice(0, 40);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  try {
    let m;
    if ((m = p.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)\.pbf$/))) {
      // Tiles are revalidated on every load: after a server restart/update the browser gets the new
      // tiles immediately (it used to keep showing hour-old cached tiles); unchanged tiles answer 304.
      if (req.headers['if-none-match'] === TILE_ETAG) { res.writeHead(304, { ETag: TILE_ETAG }); res.end(); return; }
      const t = getTile(+m[1], +m[2], +m[3]);
      if (!t) { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/x-protobuf', 'Cache-Control': 'no-cache', ETag: TILE_ETAG });
      res.end(t);
      return;
    }
    if (p === '/api/meta') return json(res, 200, { bounds: [minLng, minLat, maxLng, maxLat], mapMPerGameM: MAP_M_PER_GAME_M, laneM: LANE_M });
    // phone / tablet connection: addresses of this PC on the home network, and a QR code to scan
    if (p === '/api/connect') return json(res, 200, { urls: lanUrls(), plugin: pluginConnected });
    if (p === '/api/qr.svg') {
      const target = url.searchParams.get('u') ?? lanUrls()[0] ?? `http://localhost:${PORT}`;
      if (!/^http:\/\/[\d.]+:\d+\/?$/.test(target)) { res.writeHead(400); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
      res.end(renderSVG(target, { border: 2, whiteColor: '#ffffff', blackColor: '#000000' }));
      return;
    }
    if (p === '/api/cities') {
      return json(res, 200, cityLabels
        .filter(f => guardOk(f.properties.dlcGuard))
        .map(f => ({ name: f.properties.name, rank: f.properties.scaleRank ?? 5, capital: f.properties.capital ?? 0, lngLat: f.geometry.coordinates })));
    }
    if (p === '/api/settings' && req.method === 'GET') return json(res, 200, settings);
    if (p === '/api/settings' && req.method === 'PUT') {
      const before = settings.mapDlc;
      settings = mergeDeep(settings, await readBody(req));
      writeJson('settings.json', settings);
      broadcast({ type: 'settings', settings });
      if (settings.mapDlc !== before) applyOwnedDlcs();   // show all states / owned only
      return json(res, 200, settings);
    }
    if (p === '/api/mapdlc') return json(res, 200, { owned: ownedStateNames(), detected: ownedMapDlcs != null, mode: settings.mapDlc });
    if (p === '/api/voices') return json(res, 200, allPcVoices());                // Piper voices + Windows voices
    if (p === '/api/voice/test' && req.method === 'POST') {
      const prev = settings.voice.output;
      if (prev === 'off') settings.voice.output = 'pc';
      say(`In ${spokenDistance(400)}, keep right towards ${spokenSign('I-5 N · Burlington')}. Use the two right lanes.`, true);
      settings.voice.output = prev;
      return json(res, 200, {});
    }
    if (p === '/api/favourites' && req.method === 'GET') return json(res, 200, favourites);
    if (p === '/api/favourites' && req.method === 'POST') {
      const b = await readBody(req);
      favourites.push({ id: String(Date.now()), name: String(b.name || 'Favourite').slice(0, 60), lngLat: b.lngLat, createdAt: Date.now() });
      writeJson('favourites.json', { list: favourites });
      return json(res, 200, favourites);
    }
    if ((m = p.match(/^\/api\/favourites\/(\w+)$/)) && req.method === 'DELETE') { favourites = favourites.filter(f => f.id !== m![1]); writeJson('favourites.json', { list: favourites }); return json(res, 200, favourites); }
    if (p === '/api/search') return json(res, 200, search(url.searchParams.get('q') ?? ''));
    if (p === '/api/job/earliest' && req.method === 'PUT') {   // { earliest: absolute game minute | null }
      const key = jobKey();
      if (!key) return json(res, 409, { error: 'No active job' });
      const b = await readBody(req);
      if (typeof b.earliest === 'number' && isFinite(b.earliest)) earliestByJob[key] = Math.round(b.earliest);
      else delete earliestByJob[key];
      writeJson('job-windows.json', { map: earliestByJob });
      return json(res, 200, { earliest: earliestByJob[key] ?? null });
    }
    if (p === '/api/route' && req.method === 'GET') return json(res, 200, routeForClient());
    // End: drops the driver's own stops (the route falls back to the job); on the plain job route
    // (or with ?all) guidance is switched off until the next job or a new point.
    if (p === '/api/route' && req.method === 'DELETE') {
      const own = waypoints.length > 0 || finalDest != null;
      waypoints = []; finalDest = null;
      if (!own || url.searchParams.has('all')) jobRouteOff = true;
      const err = await replan();
      return err ? json(res, 409, { error: err }) : json(res, 200, routeForClient());
    }
    // Add a point: mode 'add' (default) = one more stop on the current trip, re-ordered by distance;
    // 'replace' = the point becomes the final destination and the other stops are dropped
    // (during a job, the route continues to the job after arriving there).
    if (p === '/api/route' && req.method === 'POST') {
      const b = await readBody(req);
      const node = nodeForLngLat(b.lngLat);
      if (!node) return json(res, 400, { error: 'No road near that point' });
      const d: Destination = { id: newId(), kind: b.kind ?? 'point', name: String(b.name ?? 'Destination').slice(0, 80), nodeUid: node.uid, lngLat: b.lngLat };
      if (b.mode === 'replace') { waypoints = []; finalDest = d; }
      else waypoints.push(d);
      jobRouteOff = false;
      const err = await replan();
      return err ? json(res, 409, { error: err }) : json(res, 200, routeForClient());
    }
    const stopDel = p.match(/^\/api\/route\/stop\/([\w-]+)$/);
    if (stopDel && req.method === 'DELETE') {
      const id = stopDel[1];
      if (id === 'job') jobRouteOff = true;
      waypoints = waypoints.filter(w => w.id !== id);
      if (finalDest?.id === id) finalDest = null;
      const err = await replan();
      return err ? json(res, 409, { error: err }) : json(res, 200, routeForClient());
    }
    if (p === '/api/route/job' && req.method === 'POST') {   // guide to the job again after End
      if (!jobDest) return json(res, 404, { error: 'No active job' });
      jobRouteOff = false;
      const err = await replan();
      return err ? json(res, 409, { error: err }) : json(res, 200, routeForClient());
    }
    if (p === '/api/suggestion/accept' && req.method === 'POST') { await acceptSuggestion(); return json(res, 200, {}); }
    if (p === '/api/suggestion/dismiss' && req.method === 'POST') {
      if (suggestion) dismissedUntil[suggestion.kind] = Date.now() + 15 * 60 * 1000;
      suggestion = null; broadcast({ type: 'suggestion', suggestion: null });
      return json(res, 200, {});
    }
    if (p === '/api/suggest' && req.method === 'POST') {   // manual "find fuel / rest / mechanic now"
      const b = await readBody(req);
      const kind: StopKind = b.kind === 'rest' ? 'rest' : b.kind === 'service' ? 'service' : 'fuel';
      const stop = await bestStop(kind);
      if (!stop) return json(res, 404, { error: 'Nothing found nearby' });
      const { nodeUid, ...shown } = stop;
      const what = { fuel: 'fuel', rest: 'rest area', service: 'mechanic' }[kind];
      suggestion = { id: String(Date.now()), kind, reason: route ? `Easiest ${what} to add to your route` : `Nearest ${what}`, stop: shown, nodeUid };
      broadcast({ type: 'suggestion', suggestion: { ...suggestion, nodeUid: undefined } });
      return json(res, 200, shown);
    }
    if (p.startsWith('/maplibre/')) return sendFile(res, path.join(MAPLIBRE_DIR, path.basename(p)));
    // MapLibre requests sprites.json/.png and sprites@2x.json/.png from the style's sprite URL.
    if (/^\/sprites(@2x)?\.(json|png)$/.test(p)) return sendFile(res, path.join(SPRITES_DIR, p.slice(1)));
    const rel = p === '/' ? 'index.html' : p === '/connect' ? 'connect.html' : p.slice(1);
    if (rel.includes('..')) { res.writeHead(403); res.end(); return; }
    return sendFile(res, path.join(APP_DIR, rel));
  } catch (e) {
    log('http error', p, String(e).slice(0, 200));
    json(res, 500, { error: 'server error' });
  }
});

// ---- multi-step controls the dashboards can ask for ({ action: 'engine' | 'refuel' })
function pressPlugin(mix: string, hold = 0) {
  if (pluginWs?.readyState === WebSocket.OPEN) pluginWs.send(JSON.stringify(hold ? { press: mix, hold } : { press: mix }));
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms: number) { const t = Date.now(); while (!cond() && Date.now() - t < ms) await sleep(100); return cond(); }
const engineRunning = () => !!tel.ch['truck.engine.enabled'];
const electricsOn = () => !!tel.ch['truck.electric.enabled'];

// Engine with two-stage start (electrics first, then the starter), and plain one-key setups too.
// Off: the engine key; if the engine still runs, the electrics key. On: electrics (if off), then the
// starter held briefly; if that didn't start it, the ignition-start key as a last resort.
let engineBusy = false;
async function engineSwitch(want?: 'on' | 'off') {
  if (engineBusy) return;
  engineBusy = true;
  try {
    const target = want ?? (engineRunning() ? 'off' : 'on');
    if (target === 'off') {
      if (!engineRunning()) return;
      pressPlugin('engine');
      if (!(await waitFor(() => !engineRunning(), 2000))) { pressPlugin('engineelect'); await waitFor(() => !engineRunning(), 2000); }
    } else {
      if (engineRunning()) return;
      if (!electricsOn()) { pressPlugin('engineelect'); await waitFor(electricsOn, 1500); await sleep(400); }
      pressPlugin('engine', 700);
      if (!(await waitFor(engineRunning, 4000))) { pressPlugin('ignitionstrt', 1500); await waitFor(engineRunning, 4000); }
    }
    log(`engine ${target}: ${engineRunning() ? 'running' : 'off'}${electricsOn() ? ' (electrics on)' : ''}`);
  } finally { engineBusy = false; }
}

// Refuel to full with one tap: the game refuels while Enter is held at the pump, so Enter is held
// (in overlapping 1.5 s holds) until the tank is full, the fuel stops rising (not at a pump), the car
// moves, or the driver taps again. The engine is switched off first, the game requires it.
let refuelState: { stop: boolean } | null = null;
async function refuelFull() {
  if (refuelState) { refuelState.stop = true; return; }
  const st = { stop: false };
  refuelState = st;
  broadcast({ type: 'refuel', active: true });
  try {
    if (engineRunning()) { await engineSwitch('off'); await sleep(500); }
    const cap = Number(tel.cfg.truck?.['fuel.capacity']) || 0;
    const fuel = () => Number(tel.ch['truck.fuel.amount']) || 0;
    let lastFuel = fuel(), lastRise = Date.now();
    const t0 = Date.now();
    while (!st.stop && Date.now() - t0 < 240000) {
      pressPlugin('activate', 1500);
      await sleep(500);
      const f = fuel();
      if (f > lastFuel + 0.005) { lastFuel = f; lastRise = Date.now(); }
      if (cap && f >= cap * 0.995) break;                          // full
      if (Date.now() - lastRise > (Date.now() - t0 < 6000 ? 6000 : 3500)) break;   // not filling (6 s to start, then 3.5 s)
      if (Math.abs(tel.ch['truck.speed'] ?? 0) > 1) break;          // drove off
    }
    log(`refuel done: ${cap ? Math.round((fuel() / cap) * 100) : '?'} %`);
  } finally {
    refuelState = null;
    broadcast({ type: 'refuel', active: false, pct: fuelPct() });
  }
}

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', settings, route: routeForClient(), suggestion: suggestion ? { ...suggestion, nodeUid: undefined } : null }, (_k, v) => (typeof v === 'bigint' ? v.toString(16) : v)));
  ws.on('message', data => {
    try {
      const msg = JSON.parse(String(data));
      if (msg.press && pluginWs?.readyState === WebSocket.OPEN) {
        const hold = Math.max(0, Math.min(6000, Number(msg.hold) || 0));
        pluginWs.send(JSON.stringify(hold ? { press: String(msg.press), hold } : { press: String(msg.press) }));
      }
      if (msg.action === 'engine') void engineSwitch(msg.want === 'on' || msg.want === 'off' ? msg.want : undefined);
      if (msg.action === 'refuel') void refuelFull();
    } catch { /* ignore */ }
  });
  ws.on('close', () => clients.delete(ws));
});

// This PC's addresses on the home network (private IPv4), real network cards first, virtual
// adapters (WSL, Hyper-V, VirtualBox, VMware, VPNs) can't be reached from a phone.
function lanUrls() {
  const isPrivate = (a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  const virtual = /vethernet|virtualbox|vmware|wsl|hyper-v|loopback|tailscale|zerotier|vpn|bluetooth/i;
  const list: { addr: string; score: number }[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const i of addrs ?? []) {
      if (i.family !== 'IPv4' || i.internal || !isPrivate(i.address)) continue;
      list.push({ addr: i.address, score: (virtual.test(name) ? 0 : 2) + (i.address.startsWith('192.168.') ? 1 : 0) });
    }
  }
  return list.sort((a, b) => b.score - a.score).map(x => `http://${x.addr}:${PORT}`);
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanUrls().map(u => u.replace(/^http:\/\/|:\d+\/?$/g, ''));
  log(`ATS Co-Driver ready: open ${ips.map(ip => `http://${ip}:${PORT}`).join(' or ')} on your phone/tablet`);
});
