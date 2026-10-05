// Animated scenes for the ATS Co-Driver website.
// Each scene is the real app, simulated: the same map renderer (MapLibre) and map style, real roads, exits,
// lanes and stations cut from the game map (site/scenes/*.json, made by build/site-scenes.mjs from a
// running Co-Driver server), and the app's own camera rules, zoom by speed, tilt, and the junction
// zoom that starts 15 s (busy interchanges 21 s) before a maneuver. A car drives the real route; the
// overlays (banner, lanes, suggestions, the Enter button…) are the app's, with its colours and sizes.
'use strict';

// ---------------------------------------------------------------- helpers
const DEBUG = /[?&]debug\b/.test(location.search);
// playback speed of every scene (driving and the pauses between steps); fades and the reading time
// of the voice bubbles stay real-time so they remain readable
const SPEED = 1.6;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const h = (tag, cls, html, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; parent?.appendChild(e); return e; };

// the app's icons (24×24 line icons)
const ICONS = {
  power: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  lowbeam: '<path d="M14 5c3.9 0 7 3.1 7 7s-3.1 7-7 7c-1.1 0-2-.9-2-2V7c0-1.1.9-2 2-2z"/><path d="M9 8 3 10M9 12 3 14M9 16l-6 2"/>',
  highbeam: '<path d="M14 5c3.9 0 7 3.1 7 7s-3.1 7-7 7c-1.1 0-2-.9-2-2V7c0-1.1.9-2 2-2z"/><path d="M9 8H3M9 12H3M9 16H3"/>',
  left: '<path d="M10 5 3 12l7 7v-4h11V9H10z" fill="currentColor" stroke="none"/>',
  right: '<path d="m14 5 7 7-7 7v-4H3V9h11z" fill="currentColor" stroke="none"/>',
  hazard: '<path d="M12 3 2 20h20z"/><path d="M12 9.5 7.5 17h9z"/>',
  wipers: '<path d="M2 17c2.5-5 6-7.5 10-7.5S19.5 12 22 17"/><path d="M12 20 6.5 11"/><circle cx="12" cy="20" r="1.2" fill="currentColor"/>',
  park: '<circle cx="12" cy="12" r="6.5"/><path d="M10.2 15.5v-7h2.3a2 2 0 0 1 0 4h-2.3"/><path d="M4.5 6a10 10 0 0 0 0 12M19.5 6a10 10 0 0 1 0 12"/>',
  cruise: '<path d="M4.5 17a8 8 0 1 1 15 0"/><path d="m12 13 4-4"/><circle cx="12" cy="13" r="1.3" fill="currentColor"/>',
  horn: '<path d="M3 10v4h3l8 5V5L6 10z"/><path d="M17 9a4 4 0 0 1 0 6M19.5 6.5a8 8 0 0 1 0 11"/>',
  beacon: '<path d="M7 18v-5a5 5 0 0 1 10 0v5"/><path d="M5 18h14v3H5z"/><path d="M12 3v2M4.5 6.5 6 8M19.5 6.5 18 8"/>',
  camera: '<path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/>',
  radio: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M7 8l10-5"/><circle cx="8.5" cy="14" r="2.5"/><path d="M14 12h4M14 16h4"/>',
  fuel: '<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M6.5 8h5"/><path d="M14 11h2a2 2 0 0 1 2 2v3.5a1.5 1.5 0 0 0 3 0V8l-3-3"/>',
  bed: '<path d="M3 19V6M3 15h18v4M21 15v-2.5A3.5 3.5 0 0 0 17.5 9H11v6"/><circle cx="7" cy="12" r="2"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 5 5"/>',
  box: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
  flag: '<path d="M5 21V4h12l-2.5 4L17 12H5"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  widgets: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><path d="M17.25 14v6.5M14 17.25h6.5"/>',
  locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L21 12.6a6 6 0 0 1-7.4 1.8L7 21a2.1 2.1 0 0 1-3-3l6.6-6.6A6 6 0 0 1 12.4 4L13.7 5.3a4 4 0 0 0 1 1z"/>',
  house: '<path d="M3 11 12 4l9 7v9H3z"/><path d="M9 20v-6h6v6"/>',
  person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  truck: '<path d="M2 7h11v9H2zM13 10h4l3 3v3h-7"/><circle cx="6" cy="17.5" r="1.8"/><circle cx="16.5" cy="17.5" r="1.8"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  enter: '<path d="M20 5v7a3 3 0 0 1-3 3H6"/><path d="m10 11-4 4 4 4"/>',
  chevron: '<path d="m6 15 6-6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
const icon = n => `<svg class="i" viewBox="0 0 24 24">${ICONS[n] ?? ''}</svg>`;

// ---------------------------------------------------------------- formatting (the app's, imperial)
function fmtDist(m) {
  const mi = m / 1609.34;
  return mi < 0.2 ? `${Math.max(0, Math.round((m * 3.28084) / 50) * 50)} ft` : `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
}
const fmtDur = min => { const t = Math.round(min), hh = Math.floor(t / 60), mm = t % 60; return hh ? `${hh}h ${mm}m` : `${mm}m`; };
const DIR = { 0: '↑', 1: '↗', 2: '←', 3: '↙', 4: '↶', 11: '↗', 12: '→', 13: '↘', 14: '↷', 29: '↗', '-1': '⤴', '-2': '↑', '-3': '🏁', '-4': '⛴' };
const DIR_TEXT = { 0: 'Continue', 1: 'Keep left', 2: 'Turn left', 3: 'Sharp left', 4: 'U-turn', 11: 'Keep right', 12: 'Turn right', 13: 'Sharp right', 14: 'U-turn', 29: 'Exit the roundabout', '-1': 'Merge', '-2': 'Start', '-3': 'Arrive', '-4': 'Take the ferry' };
// keep-left arrows point up-left (the app's ↗ is for keep right; ↖ for keep left)
const dirArrow = d => (d === 1 ? '↖' : DIR[d] ?? (d >= 21 && d <= 28 ? '⟳' : '↑'));
const dirText = (d, exit) => (d >= 21 && d <= 28 ? `Roundabout, take exit ${exit ?? ''}` : DIR_TEXT[d] ?? 'Continue');

// lane arrows, exactly like the app
const BRANCH_ANGLE = { 0: 0, '-1': 0, 1: -45, 2: -90, 3: -135, 4: -180, 11: 45, 12: 90, 13: 135, 14: 180 };
function branchPath(b) {
  const a = BRANCH_ANGLE[b] ?? 0;
  if (Math.abs(a) === 180) return a < 0 ? { d: 'M20 38 V17 A6 6 0 0 0 8 17 V26', end: [8, 28], dir: [0, 1] } : { d: 'M12 38 V17 A6 6 0 0 1 24 17 V26', end: [24, 28], dir: [0, 1] };
  const r = (a * Math.PI) / 180, u = [Math.sin(r), -Math.cos(r)];
  const len = Math.abs(a) >= 90 ? 11 : 15;
  const end = [16 + u[0] * len, 22 + u[1] * len];
  return { d: `M16 38 V22 L${end[0].toFixed(1)} ${end[1].toFixed(1)}`, end, dir: u };
}
function laneSvg(branches, active) {
  const order = [...new Set(branches)].sort((a, b) => (a === active) - (b === active));
  return `<svg viewBox="0 0 32 40" fill="none" stroke-linecap="round" stroke-linejoin="round">${order.map(b => {
    const { d, end, dir } = branchPath(b);
    const col = b === active ? '#fff' : '#ffffff55', n = [-dir[1], dir[0]], tip = [end[0] + dir[0] * 3, end[1] + dir[1] * 3];
    const head = [tip, [end[0] - dir[0] * 4 + n[0] * 5, end[1] - dir[1] * 4 + n[1] * 5], [end[0] - dir[0] * 4 - n[0] * 5, end[1] - dir[1] * 4 - n[1] * 5]];
    return `<path d="${d}" stroke="${col}" stroke-width="3.5"/><polygon points="${head.map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')}" fill="${col}"/>`;
  }).join('')}</svg>`;
}
// the app's spoken phrases (server voiceTick)
function spokenDistance(m) {
  const ft = m * 3.28084, mi = m / 1609.34;
  if (mi < 0.18) { const r = ft < 600 ? 50 : 100; return `${Math.max(r, Math.round(ft / r) * r)} feet`; }
  if (mi < 0.35) return 'a quarter mile';
  if (mi < 0.65) return 'half a mile';
  if (mi < 0.85) return 'three quarters of a mile';
  const r = Math.round(mi * 2) / 2;
  return r === 1 ? '1 mile' : `${r} miles`;
}
const spokenTurn = d => ({ 0: 'continue straight', 1: 'keep left', 2: 'turn left', 3: 'turn sharply left', 4: 'make a U-turn', 11: 'keep right', 12: 'turn right', 13: 'turn sharply right', 14: 'make a U-turn', '-1': 'merge', '-3': 'you will arrive at your destination' })[d] ?? 'continue';
function spokenLanes(lanes) {
  if (!lanes || lanes.length < 2) return '';
  const act = lanes.map((l, i) => (l.active != null ? i : -1)).filter(i => i >= 0);
  if (!act.length || act.length === lanes.length) return '';
  const n = act.length, num = ['', 'the', 'the two', 'the three', 'the four'][n] ?? `${n}`, lane = n === 1 ? 'lane' : 'lanes';
  if (act[0] === 0) return `use ${num} left ${lane}`;
  if (act[n - 1] === lanes.length - 1) return `use ${num} right ${lane}`;
  return `use ${num} middle ${lane}`;
}
const capFirst = s => s[0].toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- geometry (lng/lat ↔ map metres)
const RAD = Math.PI / 180;
const metres = (a, b) => { const dLat = (b[1] - a[1]) * RAD, dLng = (b[0] - a[0]) * RAD * Math.cos(((a[1] + b[1]) / 2) * RAD); return Math.sqrt(dLat * dLat + dLng * dLng) * 6371000; };
const bearingOf = (a, b) => { const y = Math.sin((b[0] - a[0]) * RAD) * Math.cos(b[1] * RAD), x = Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) - Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos((b[0] - a[0]) * RAD); return (Math.atan2(y, x) / RAD + 360) % 360; };
const angleDiff = (a, b) => ((b - a + 540) % 360) - 180;
const pairs = flat => { const out = []; for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
const GEO_MPP_Z0 = 78271.517;

// A route of a scene: the drawn line, its maneuvers and stops, and a speed profile for the car.
class Route {
  constructor(j, extra = [], extraCap = 9) {
    this.k = j.k;                                   // game metres per map metre on this route
    this.pts = pairs(j.line).concat(extra);
    this.cum = [0];
    for (let i = 1; i < this.pts.length; i++) this.cum.push(this.cum[i - 1] + metres(this.pts[i - 1], this.pts[i]));
    this.total = this.cum[this.cum.length - 1];
    this.caps = j.caps.concat(extra.map(() => extraCap));
    this.steps = j.steps.filter(s => s.d !== '-2');
    this.stops = j.stops ?? [];
  }
  idx(s) { let lo = 0, hi = this.cum.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.cum[m] <= s) lo = m; else hi = m; } return lo; }
  pos(s) {
    s = clamp(s, 0, this.total);
    const i = Math.min(this.idx(s), this.pts.length - 2), a = this.pts[i], b = this.pts[i + 1];
    const t = (s - this.cum[i]) / Math.max(1e-9, this.cum[i + 1] - this.cum[i]);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  heading(s) { const d = 12 / this.k; return bearingOf(this.pos(s - d * 0.3), this.pos(s + d)); }
  slice(to) { const out = []; for (let i = 0; i < this.pts.length && this.cum[i] < to; i++) out.push(this.pts[i]); out.push(this.pos(to)); return out.length > 1 ? out : [this.pts[0], this.pts[0]]; }
  geo(to = this.total) { return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: this.slice(to) } }; }
  // Speed profile (game m/s) along the line: road caps (60 / 45 / 30 mph), slower in curves, smooth
  // braking and acceleration, stopping at `stopAt` (map metres) or the end.
  profile({ v0 = 26.8, stopAt = this.total, cruise = 26.8 } = {}) {
    const n = this.pts.length, v = new Float32Array(n), dGame = 14 / this.k;
    for (let i = 0; i < n; i++) {
      const s = this.cum[i];
      const a = bearingOf(this.pos(s - dGame), this.pos(s)), b = bearingOf(this.pos(s), this.pos(s + dGame));
      const turn = Math.abs(angleDiff(a, b)) * RAD;
      const R = turn > 1e-3 ? 14 / turn : 1e9;                 // radius in game metres
      // the game world is compressed, so its curves are tight on paper: freeway bends are taken at
      // 60 mph, town corners at ~15–20 mph
      v[i] = Math.min(this.caps[i] ?? cruise, cruise, Math.sqrt(8 * R));
      if (s >= stopAt) v[i] = 0;
    }
    for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * 2.6 * (this.cum[i + 1] - this.cum[i]) * this.k));
    v[0] = Math.min(v[0], v0);
    for (let i = 1; i < n; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * 1.7 * (this.cum[i] - this.cum[i - 1]) * this.k));
    this.vp = v; this.stopAt = stopAt;
  }
  speedAt(s) { const i = Math.min(this.idx(s), this.pts.length - 2), t = (s - this.cum[i]) / Math.max(1e-9, this.cum[i + 1] - this.cum[i]); return lerp(this.vp[i], this.vp[i + 1], clamp(t, 0, 1)); }
  // next maneuver ahead of `s` (like the server: the step whose maneuver lies ahead)
  nav(s) {
    const i = this.steps.findIndex(st => st.at > s + 1);
    if (i < 0) return null;
    const n = this.steps[i], after = this.steps[i + 1];
    return { n, after, i, toNext: (n.at - s) * this.k, stepDist: after ? (after.at - n.at) * this.k : Infinity };
  }
}

// ---------------------------------------------------------------- map style (the app's, on GeoJSON)
const PALETTE = {
  night: { land: '#1a1a1a', freeway: ['#b8963e', '#5a4a24'], divided: ['#6b7280', '#3a3f47'], local: ['#4b5059', '#2b2f35'],
    areas: ['hsl(200,2%,36%)', 'hsl(38,25%,35%)', 'hsl(38,25%,25%)', 'hsl(143,20%,25%)', 'hsl(0,100%,25%)', 'hsl(107,51%,25%)', 'hsl(201,53%,25%)', 'hsl(53,84%,25%)', 'hsl(267,46%,25%)'] },
  day: { land: '#f8f8f8', freeway: ['#f5c242', '#c98f1c'], divided: ['#9aa4b1', '#7d8794'], local: ['#b9c0c9', '#98a1ac'],
    areas: ['hsl(200,8%,92%)', 'hsl(38,59%,76%)', 'hsl(38,64%,58%)', 'hsl(92,31%,70%)', 'hsl(0,100%,30%)', 'hsl(107,51%,43%)', 'hsl(201,53%,39%)', 'hsl(53,84%,53%)', 'hsl(267,46%,45%)'] },
};
const areaColor = p => ['match', ['get', 'color'], ...p.areas.flatMap((c, i) => [i, c]), p.areas[0]];
const roadColor = (p, i) => ['match', ['get', 'rt'], 'freeway', p.freeway[i], 'divided', p.divided[i], p.local[i]];
const M2PX = z => Math.pow(2, z) / 62500;
const trueW = z => ['*', ['coalesce', ['get', 'w'], 300], M2PX(z)];
const ROAD_W = ['interpolate', ['exponential', 2], ['zoom'],
  3, ['match', ['get', 'rt'], 'freeway', 1.6, 'divided', 1.2, 0.9], 7, ['match', ['get', 'rt'], 'freeway', 2.4, 'divided', 1.8, 1.3],
  10, ['max', ['match', ['get', 'rt'], 'freeway', 3.2, 'divided', 2.6, 2], trueW(10)], 20, trueW(20)];
const CASE_W = ['interpolate', ['exponential', 1.5], ['zoom'], 3, 0.5, 8, 1, 14, 2, 16, 3];
const ROUTE_M = 135;
const ROUTE_W = ['interpolate', ['exponential', 2], ['zoom'], 5, 3, 10, 6, 12, Math.max(6, ROUTE_M * M2PX(12)), 20, ROUTE_M * M2PX(20)];
const ROUTE_CW = ['interpolate', ['exponential', 2], ['zoom'], 5, 5, 10, 9, 12, Math.max(9, ROUTE_M * 1.35 * M2PX(12)), 20, ROUTE_M * 1.35 * M2PX(20)];
const RT = ['local', 'divided', 'freeway'];
const empty = () => ({ type: 'FeatureCollection', features: [] });
function mapGeo(m) {
  return {
    areas: { type: 'FeatureCollection', features: m.areas.map(a => ({ type: 'Feature', properties: { t: a[0] ? 'prefab' : 'mapArea', color: a[1], z: a[2] }, geometry: { type: 'Polygon', coordinates: [pairs(a[3])] } })) },
    roads: { type: 'FeatureCollection', features: m.roads.map(r => ({ type: 'Feature', properties: { rt: RT[r[0]], w: r[1] }, geometry: { type: 'LineString', coordinates: pairs(r[2]) } })) },
    pois: { type: 'FeatureCollection', features: dedupe(m.pois.filter(p => p[0] !== 'company')).map(p => ({ type: 'Feature', properties: { k: p[0], s: p[1] }, geometry: { type: 'Point', coordinates: [p[3], p[4]] } })) },
  };
}
// a truck stop has an icon per pump island: one icon per kind and place is enough
function dedupe(pois) {
  const kept = [];
  for (const p of pois) if (!kept.some(q => q[1] === p[1] && metres([q[3], q[4]], [p[3], p[4]]) < 700)) kept.push(p);
  return kept;
}
function mapStyle(geo, night = true) {
  const p = PALETTE[night ? 'night' : 'day'];
  return {
    version: 8,
    sources: {
      areas: { type: 'geojson', data: geo.areas }, roads: { type: 'geojson', data: geo.roads }, pois: { type: 'geojson', data: geo.pois },
      routeOld: { type: 'geojson', data: empty() }, route: { type: 'geojson', data: empty() },
    },
    layers: [
      { id: 'land', type: 'background', paint: { 'background-color': p.land } },
      { id: 'mapAreas', type: 'fill', source: 'areas', filter: ['==', ['get', 't'], 'mapArea'], layout: { 'fill-sort-key': ['get', 'z'] }, paint: { 'fill-color': areaColor(p) } },
      { id: 'prefabs', type: 'fill', source: 'areas', filter: ['==', ['get', 't'], 'prefab'], layout: { 'fill-sort-key': ['get', 'z'] }, paint: { 'fill-color': areaColor(p) } },
      { id: 'roads-case', type: 'line', source: 'roads', layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['match', ['get', 'rt'], 'freeway', 2, 'divided', 1, 0] }, paint: { 'line-color': roadColor(p, 1), 'line-gap-width': ROAD_W, 'line-width': CASE_W } },
      { id: 'roads', type: 'line', source: 'roads', layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['match', ['get', 'rt'], 'freeway', 2, 'divided', 1, 0] }, paint: { 'line-color': roadColor(p, 0), 'line-width': ROAD_W } },
      { id: 'route-old', type: 'line', source: 'routeOld', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#8593a5', 'line-width': ROUTE_W, 'line-opacity': 0.55 } },
      { id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0b3d91', 'line-width': ROUTE_CW, 'line-opacity': 0.9 } },
      { id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#3b9cff', 'line-width': ROUTE_W, 'line-opacity': 0.9 } },
      { id: 'road-shields', type: 'symbol', source: 'pois', minzoom: 5, filter: ['==', ['get', 'k'], 'road'], layout: { 'icon-image': ['get', 's'], 'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.75, 10, 1, 14, 1.15], 'icon-padding': 1 } },
      { id: 'facility-icons', type: 'symbol', source: 'pois', minzoom: 4, filter: ['==', ['get', 'k'], 'facility'], layout: { 'icon-image': ['get', 's'], 'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.7, 8, 0.9, 12, 1.15, 15, 1.4], 'icon-padding': 0, 'icon-allow-overlap': ['step', ['zoom'], false, 9, true] } },
    ],
  };
}
function applyTheme(map, night) {
  const p = PALETTE[night ? 'night' : 'day'];
  map.setPaintProperty('land', 'background-color', p.land);
  map.setPaintProperty('mapAreas', 'fill-color', areaColor(p));
  map.setPaintProperty('prefabs', 'fill-color', areaColor(p));
  map.setPaintProperty('roads-case', 'line-color', roadColor(p, 1));
  map.setPaintProperty('roads', 'line-color', roadColor(p, 0));
}

// Icons drawn here (the game's own sprites are not ours to ship): facilities as round badges with
// the app's line icons, road shields with their numbers.
function svgToCanvas(ctx, markup, x, y, size, color, width = 2.2) {
  const s = size / 24;
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const m of markup.matchAll(/<(path|circle|rect)([^>]*)\/>/g)) {
    const at = n => (m[2].match(new RegExp(`${n}="([^"]+)"`)) ?? [])[1];
    const fill = at('fill') === 'currentColor', stroke = at('stroke') !== 'none';
    let p;
    if (m[1] === 'path') p = new Path2D(at('d'));
    else if (m[1] === 'circle') { p = new Path2D(); p.arc(+at('cx'), +at('cy'), +at('r'), 0, Math.PI * 2); }
    else { p = new Path2D(); p.roundRect?.(+at('x'), +at('y'), +at('width'), +at('height'), +(at('rx') ?? 0)) ?? p.rect(+at('x'), +at('y'), +at('width'), +at('height')); }
    if (fill) ctx.fill(p);
    if (stroke) ctx.stroke(p);
  }
  ctx.restore();
}
const FACILITY = { gas_ico: ['#d68a00', 'fuel'], parking_ico: ['#2f7de0', 'P'], service_ico: ['#7a5cf0', 'wrench'], garage_large_ico: ['#4b5563', 'house'],
  dealer_ico: ['#0f8a6a', 'truck'], recruitment_ico: ['#b0413e', 'person'], weigh_station_ico: ['#8a5a00', 'W'] };
function makeImage(id) {
  const R = 2;   // pixel ratio of the drawn image
  const f = FACILITY[id];
  if (f) {
    const S = 32 * R, c = document.createElement('canvas'); c.width = c.height = S;
    const ctx = c.getContext('2d');
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 2 * R, 0, Math.PI * 2); ctx.fillStyle = f[0]; ctx.fill();
    ctx.lineWidth = 2 * R; ctx.strokeStyle = '#fff'; ctx.stroke();
    if (ICONS[f[1]]) svgToCanvas(ctx, ICONS[f[1]], S * 0.2, S * 0.2, S * 0.6, '#fff', 2.4);
    else { ctx.fillStyle = '#fff'; ctx.font = `800 ${18 * R}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(f[1], S / 2, S / 2 + R); }
    return { image: ctx.getImageData(0, 0, S, S), ratio: R };
  }
  // road shields: is5 / is405 (Interstate), us101 (US route), ca_r99 / nv_r160 … (state routes)
  let kind, num;
  let m = id.match(/^is(\d+\w*)$/); if (m) { kind = 'is'; num = m[1]; }
  else if ((m = id.match(/^us(\d+\w*)$/))) { kind = 'us'; num = m[1]; }
  else if ((m = id.match(/^([a-z]{2})_?r?(\d+\w*)$/))) { kind = m[1] === 'ca' ? 'ca' : 'state'; num = m[2]; }
  if (!kind) return null;
  const W = (num.length > 2 ? 34 : 28) * R, H = 28 * R, c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const shield = () => { const p = new Path2D(); p.moveTo(2 * R, 3 * R); p.lineTo(W - 2 * R, 3 * R); p.quadraticCurveTo(W - R, H * 0.62, W / 2, H - R); p.quadraticCurveTo(R, H * 0.62, 2 * R, 3 * R); return p; };
  if (kind === 'is') {
    const p = shield(); ctx.fillStyle = '#1f4fb4'; ctx.fill(p); ctx.save(); ctx.clip(p); ctx.fillStyle = '#c8202a'; ctx.fillRect(0, 0, W, H * 0.28); ctx.restore();
    ctx.lineWidth = 1.6 * R; ctx.strokeStyle = '#fff'; ctx.stroke(p);
  } else if (kind === 'us') {
    const p = shield(); ctx.fillStyle = '#fff'; ctx.fill(p); ctx.lineWidth = 1.8 * R; ctx.strokeStyle = '#111'; ctx.stroke(p);
  } else if (kind === 'ca') {
    const p = new Path2D(); p.moveTo(W / 2, R); p.quadraticCurveTo(W - R, H * 0.2, W - 2 * R, H * 0.55); p.quadraticCurveTo(W - 3 * R, H - 2 * R, W / 2, H - R); p.quadraticCurveTo(3 * R, H - 2 * R, 2 * R, H * 0.55); p.quadraticCurveTo(R, H * 0.2, W / 2, R);
    ctx.fillStyle = '#1b7a3a'; ctx.fill(p); ctx.lineWidth = 1.6 * R; ctx.strokeStyle = '#fff'; ctx.stroke(p);
  } else {
    ctx.beginPath(); ctx.ellipse(W / 2, H / 2, W / 2 - R, H / 2 - R, 0, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 1.6 * R; ctx.strokeStyle = '#111'; ctx.stroke();
  }
  ctx.fillStyle = kind === 'us' || kind === 'state' ? '#111' : '#fff';
  ctx.font = `800 ${(num.length > 2 ? 11.5 : 13) * R}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(num.toUpperCase(), W / 2, H * (kind === 'is' ? 0.6 : 0.52));
  return { image: ctx.getImageData(0, 0, W, H), ratio: R };
}

// ---------------------------------------------------------------- the app's instruments (SVG)
function arcPath(cx, cy, r) { const a0 = (135 * Math.PI) / 180, a1 = (45 * Math.PI) / 180, p = a => `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`; return `M${p(a0)} A${r} ${r} 0 1 1 ${p(a1)}`; }
function arcPoint(cx, cy, r, f) { const a = ((135 + 270 * clamp(f, 0, 1)) * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }
const SPEEDO_LEN = 54 * 1.5 * Math.PI, REV_LEN = 42 * 1.5 * Math.PI;
function speedoHtml() {
  const ticks = Array.from({ length: 11 }, (_, i) => { const [x1, y1] = arcPoint(68, 64, 44, i / 10), [x2, y2] = arcPoint(68, 64, 39, i / 10); return `<line class="tick" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke-width="1.5"/>`; }).join('');
  const [l1, m1] = arcPoint(68, 64, 47, 60 / 90), [l2, m2] = arcPoint(68, 64, 61, 60 / 90);
  return `<div class="gauge"><svg class="speedo" viewBox="0 0 136 112"><path class="track" d="${arcPath(68, 64, 54)}" fill="none" stroke-width="9" stroke-linecap="round"/>
    <path class="val" d="${arcPath(68, 64, 54)}" fill="none" stroke-width="9" stroke-linecap="round" stroke-dasharray="${SPEEDO_LEN.toFixed(1)} 999" stroke-dashoffset="${SPEEDO_LEN.toFixed(1)}"/>
    ${ticks}<line class="lim" x1="${l1.toFixed(1)}" y1="${m1.toFixed(1)}" x2="${l2.toFixed(1)}" y2="${m2.toFixed(1)}" stroke-width="4" stroke-linecap="round"/>
    <text class="big" x="68" y="72">0</text><text class="unit" x="68" y="88">mph</text><text class="unit cc" x="68" y="108"></text></svg></div>`;
}
const revsHtml = () => `<div class="gauge"><svg class="revs" viewBox="0 0 104 104"><path class="track" d="${arcPath(52, 50, 42)}" fill="none" stroke-width="7" stroke-linecap="round"/>
  <path class="red" d="${arcPath(52, 50, 42)}" fill="none" stroke-width="7" stroke-dasharray="0 ${(REV_LEN * 0.86).toFixed(1)} ${(REV_LEN * 0.14).toFixed(1)} 999"/>
  <path class="val" d="${arcPath(52, 50, 42)}" fill="none" stroke-width="7" stroke-linecap="round" stroke-dasharray="${REV_LEN.toFixed(1)} 999" stroke-dashoffset="${REV_LEN.toFixed(1)}"/>
  <text class="gear" x="52" y="64">N</text><text class="rpm" x="52" y="98">0.8k rpm</text></svg></div>`;
const fuelHtml = () => `<div class="gauge bargauge fuelG"><div class="bgTop">${icon('fuel')}<b>–</b><span class="sub">–</span></div><div class="segs">${'<i></i>'.repeat(10)}</div><div class="bgScale"><span>E</span><span>½</span><span>F</span></div></div>`;
const TELLTALES = [['left', 'green'], ['lowbeam', 'green'], ['highbeam', 'blue'], ['hazard', 'red'], ['park', 'red'], ['cruise', 'green'], ['wipers', 'green'], ['beacon', 'amber'], ['fuel', 'amber'], ['wrench', 'amber'], ['power', 'red'], ['right', 'green']];
const telltalesHtml = () => `<div class="telltales">${TELLTALES.map(([n, c]) => `<span class="tt ${c}" data-tt="${n}">${icon(n)}</span>`).join('')}</div>`;
const btnHtml = (ic, label, cls = '') => `<div class="w btn ${cls}" data-b="${ic}">${icon(ic)}<span class="lbl">${label}</span><span class="led"></span></div>`;
const DOCK = [['power', 'Engine on', 'on'], ['lowbeam', 'Lights', 'on'], ['highbeam', 'High beam'], ['hazard', 'Hazards'], ['left', 'Left'], ['right', 'Right'], ['wipers', 'Wipers off'], ['park', 'Park brake'], ['cruise', 'Cruise', 'on'], ['horn', 'Horn'], ['camera', 'Park cams'], ['beacon', 'Beacon']];
const deliveryHtml = j => `<div class="card deliveryCard" data-state="ok">
  <div class="dvHead">${icon('box')}<div class="dvWhat"><b class="cargo">${j.cargo}</b><span class="mass">${j.mass}</span></div><b class="pay">${j.pay}</b></div>
  <div class="dvRoute"><span>${j.from}</span><i>→</i><span class="to">${j.to}</span></div>
  <div class="progLine"><div class="pbar"><i></i></div><b class="pct">0%</b><span class="pleft"></span></div>
  <div class="dvStatus"><span class="dot"></span><b class="stTitle">On time</b><span class="stSub"></span></div>
  <div><div class="dvBar"><i class="early" style="width:44%"></i><i class="win" style="left:44%;width:47%"></i><i class="late" style="left:91%"></i><span class="mk dl" style="left:91%"></span><span class="mk eta" style="left:30%"></span></div>
    <div class="dvTicks"><span class="tNow">now</span><span class="tEta" style="left:30%"></span><span class="tDue">deadline</span></div></div>
  <div class="dvGrid"><div><span class="k">Arrive</span><b class="arr">–</b><small class="arrIn"></small></div><div><span class="k">Window</span><b>${j.window}</b><small style="color:var(--acc)">guess (5 h) · tap to set</small></div><div><span class="k">Deadline</span><b>${j.due}</b><small class="left"></small></div></div>
  <div class="dvCargo"><span class="k">Cargo damage</span><div class="cbar"><i></i></div><b>1.2%</b></div></div>`;
const JOB = { cargo: 'Used cars', mass: '3.4 t', pay: '$4,820', from: 'Bakersfield · Showroom', to: 'Fresno · Aron', window: '15:16–20:16 PT', due: 'Sun 20:16 PT' };

// ---------------------------------------------------------------- data
const dataCache = {};
const loadData = name => (dataCache[name] ??= fetch(`scenes/${name}.json`).then(r => { if (!r.ok) throw new Error(name); return r.json(); }));

// ---------------------------------------------------------------- a stage: one simulated app screen
class Stage {
  constructor(host, { w = 1024, h = 640, layout = 'map', dock = false } = {}) {
    this.host = host; this.W = w; this.H = h;
    const root = this.root = document.createElement('div');
    root.className = 'vs'; root.style.width = w + 'px'; root.style.height = h + 'px';
    const grid = h_(root, 'div', 'grid' + (layout === 'tablet' ? ' tablet' : layout === 'side' ? ' withSide' : dock ? ' withDock' : ''));
    this.mapWrap = h_(grid, 'div', 'mapWrap');
    this.mapEl = h_(this.mapWrap, 'div', 'mapEl');
    this.haze = h_(this.mapWrap, 'div', 'haze');
    if (layout === 'tablet' || layout === 'side') this.console = h_(grid, 'div', 'console');
    if (layout === 'tablet' || dock) this.dock = h_(grid, 'div', 'dock', DOCK.map(([ic, l, on]) => btnHtml(ic, l, on ?? '')).join(''));
    // the app's map overlays
    this.banner = h_(this.mapWrap, 'div', 'navBanner', `<div class="arrow">↑</div><div class="navText"><div class="navDist">–</div><div class="navWhat"></div></div>
      <div class="navThen" hidden>then <span>↱</span></div><div class="laneStrip" hidden></div><div class="navProgress"><i></i></div>`);
    this.banner.hidden = true;
    this.quick = h_(this.mapWrap, 'div', 'quick', btnHtml('fuel', 'Fuel', 'fuel') + btnHtml('bed', 'Rest', 'rest') + btnHtml('wrench', 'Mechanic', 'service') + btnHtml('star', 'Favourites'));
    this.mapButtons = h_(this.mapWrap, 'div', 'mapButtons', `<div class="round fold">${icon('chevron')}</div><div class="round on">${icon('locate')}</div><div class="round">N</div><div class="round">${icon('search')}</div><div class="round theme">${icon('moon')}</div><div class="round edit">${icon('widgets')}</div><div class="round">${icon('sliders')}</div>`);
    this.prompt = h_(this.mapWrap, 'div', 'actionPrompt', `<div class="apIcon">${icon('box')}</div><div class="apText"><b></b><span></span></div><div class="apGo"></div>`);
    this.sheet = h_(this.mapWrap, 'div', 'sheet');
    this.toastEl = h_(this.mapWrap, 'div', 'toast');
    this.voiceEl = h_(this.mapWrap, 'div', 'voice', '<span class="wave"><i></i><i></i><i></i><i></i></span><span class="txt"></span>');
    this.chipEl = h_(this.mapWrap, 'div', 'chip');
    this.ffEl = h_(this.mapWrap, 'div', 'chip ff', '⏩ <b>×3</b> fast-forward');
    this.fadeEl = h_(root, 'div', 'fade on');
    host.appendChild(root);
    this.fit();
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(host);
    this.alive = false; this.gen = 0; this.waiters = []; this.markers = [];
    this.timeScale = 1; this.car = null; this.cam = null; this.onFrame = null; this.night = true;
  }
  fit() {
    const s = this.host.clientWidth / this.W || 1;
    this.scale = s;
    this.root.style.transform = `scale(${s})`;
    if (this.map) this.map.setPixelRatio(Math.min(2, (window.devicePixelRatio || 1) * s));
  }
  async init(geo, view) {
    this.map = new maplibregl.Map({
      container: this.mapEl, style: mapStyle(geo, true), center: view.center, zoom: view.zoom ?? 12, bearing: view.bearing ?? 0, pitch: view.pitch ?? 0,
      interactive: false, attributionControl: false, fadeDuration: 0, maxPitch: 60, pixelRatio: Math.min(2, (window.devicePixelRatio || 1) * this.scale),
    });
    this.map.on('styleimagemissing', e => { if (this.map.hasImage(e.id)) return; const im = makeImage(e.id); if (im) this.map.addImage(e.id, im.image, { pixelRatio: im.ratio }); });
    await new Promise(r => this.map.once('load', r));
    const el = h_(null, 'div', '', '<svg class="truckMarker" viewBox="0 0 44 44"><circle cx="22" cy="22" r="20" fill="#3b9cff33"/><path d="M22 6 L34 36 L22 29 L10 36 Z" fill="#3b9cff" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/></svg>');
    this.truck = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat(view.center);
  }
  setMap(m) {
    const geo = mapGeo(m);
    for (const k of ['areas', 'roads', 'pois']) this.map.getSource(k).setData(geo[k]);
    for (const mk of this.labels ?? []) mk.marker.remove();
    this.labels = [];
    for (const c of m.cities) { const e = h_(null, 'div', 'cityLabel' + (c[1] <= 3 ? ' major' : ''), c[0]); this.labels.push({ rank: c[1], city: true, marker: new maplibregl.Marker({ element: e }).setLngLat([c[2], c[3]]) }); }
    for (const p of m.pois.filter(p => p[0] === 'company' && p[2])) { const e = h_(null, 'div', 'coLabel', `<i>▣</i>${p[2]}`); this.labels.push({ co: true, marker: new maplibregl.Marker({ element: e, anchor: 'left', offset: [6, 0] }).setLngLat([p[3], p[4]]) }); }
    this.updateLabels(true);
  }
  updateLabels(force) {
    const z = this.map.getZoom();
    if (!force && Math.abs(z - (this.lastLabelZ ?? -9)) < 0.15) return;
    this.lastLabelZ = z;
    for (const l of this.labels ?? []) {
      const show = l.city ? z >= 9 || (z >= 7 && l.rank <= 6) || (z >= 5 && l.rank <= 3) : z >= 12.2;
      if (show && !l.on) { l.marker.addTo(this.map); l.on = true; } else if (!show && l.on) { l.marker.remove(); l.on = false; }
    }
  }
  showRoute(route, to) { this.map.getSource('route').setData(route ? route.geo(to ?? route.total) : empty()); }
  async drawRoute(route, ms = 1200) {
    const t0 = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - t0) * SPEED / ms);
      this.showRoute(route, route.total * ease(t));
      if (t >= 1) return;
      await this.frame();
    }
  }
  pin(ll, { n, kind = '', final = false, drop = true } = {}) {
    const glyph = final ? (kind === 'job' ? icon('box') : icon('flag')) : n != null ? String(n) : '';
    const e = h_(null, 'div', `stopPin k-${kind}${final ? ' final' : ''}${drop ? ' drop' : ''}`, `<div class="pinBody"><span>${glyph}</span></div>`);
    const m = new maplibregl.Marker({ element: e, anchor: 'bottom' }).setLngLat(ll).addTo(this.map);
    this.markers.push(m);
    return { el: e, marker: m, set: v => { e.querySelector('span').textContent = v; }, remove: () => m.remove() };
  }
  clearPins() { for (const m of this.markers) m.remove(); this.markers = []; }

  // --- timing (everything aborts when the scene scrolls away)
  frame() { return new Promise((res, rej) => { const g = this.gen; requestAnimationFrame(() => (this.alive && g === this.gen ? res() : rej('stop'))); }); }
  async wait(ms, raw = false) { const end = performance.now() + (raw ? ms : ms / SPEED); while (performance.now() < end) await this.frame(); }
  until(pred) { return new Promise((res, rej) => this.waiters.push({ pred, res, rej })); }
  tap(x, y, hold = false) { const t = h_(this.root, 'div', 'tap'); t.style.left = x + 'px'; t.style.top = y + 'px'; void t.offsetWidth; t.classList.add(hold ? 'hold' : 'go'); setTimeout(() => t.remove(), 1100); }
  tapEl(e, hold = false) { const r = e.getBoundingClientRect(), o = this.root.getBoundingClientRect(); this.tap((r.left + r.width / 2 - o.left) / this.scale, (r.top + r.height / 2 - o.top) / this.scale, hold); e.classList.add('press'); setTimeout(() => e.classList.remove('press'), 180); }
  async toast(text, ms = 2200) { this.toastEl.textContent = text; this.toastEl.classList.add('show'); await this.wait(ms); this.toastEl.classList.remove('show'); }
  chip(html) { if (!html) { this.chipEl.classList.remove('show'); return; } this.chipEl.innerHTML = html; this.chipEl.classList.add('show'); }
  async say(text, ms) {
    if (DEBUG) console.log(`[say ${(performance.now() / 1000).toFixed(1)} s]`, text);
    this.voiceEl.querySelector('.txt').textContent = text; this.voiceEl.classList.add('show');
    await this.wait(ms ?? 1300 + text.length * 40, true); this.voiceEl.classList.remove('show'); await this.wait(250, true);
  }
  async fade(on) { if (!on) for (let i = 0; i < 4; i++) await this.frame();   // first frames drawn under the cover
    if (DEBUG) console.log(`[fade ${on ? 'out' : 'in'} ${(performance.now() / 1000).toFixed(1)} s]`); this.fadeEl.classList.toggle('on', on); return this.wait(650, true); }

  // --- driving: a car on a route, the app's camera following it
  drive(route, { from = 0, v0 = 26.8, stopAt, cruise = 26.8, keepGoing = false } = {}) {
    // keepGoing: the scene's route is a piece cut out of a longer one, no braking at its end
    route.profile({ v0, stopAt: keepGoing ? route.total * 10 + 1e6 : stopAt ?? route.total, cruise });
    this.route = route;
    this.car = { route, s: from, v: v0, done: false };
    const h = this.mapWrap.clientHeight;
    this.cam = { pos: route.pos(from), bearing: route.heading(from), zoom: null, pitch: 50, speed: v0, jx: { active: false, target: null, step: -1 }, h, snap: true };
    if (!this.truckOn) { this.truck.addTo(this.map); this.truckOn = true; }
    this.banner.hidden = false;
  }
  switchRoute(route, { stopAt } = {}) {
    // continue on another route from the same spot (e.g. via the station just added)
    const c = this.car;
    const s = nearestAlong(route, route_pos(c));
    route.profile({ v0: c.v, stopAt: stopAt ?? route.total });
    // the profile starts at s: rebuild forward from the car's speed
    for (let i = route.idx(s); i < route.pts.length; i++) { const dv = Math.sqrt(c.v ** 2 + 2 * 1.7 * Math.max(0, route.cum[i] - s) * route.k); route.vp[i] = Math.min(route.vp[i], dv); }
    this.route = route; c.route = route; c.s = s;
  }
  start(loopFn) {
    if (this.alive) return;
    this.alive = true; const g = ++this.gen;
    let last = performance.now();
    const tick = now => {
      if (!this.alive || g !== this.gen) return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      try { this.step(dt * this.timeScale * SPEED, dt); } catch (e) { console.error(e); }
      for (const w of this.waiters.splice(0)) { if (w.pred()) w.res(); else this.waiters.push(w); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    (async () => {
      while (this.alive && g === this.gen) {
        try { await loopFn(this); } catch (e) { if (e !== 'stop') { console.error(e); await sleep(1500); } }
      }
    })();
  }
  stop() { this.alive = false; this.gen++; for (const w of this.waiters.splice(0)) w.rej('stop'); }
  step(dt, realDt) {
    const c = this.car;
    if (c && !c.done) {
      const r = c.route;
      let v = r.speedAt(c.s);
      if (c.s >= r.stopAt - 0.5 / r.k || (v < 0.35 && r.stopAt - c.s < 3 / r.k)) { c.s = Math.min(c.s, r.stopAt); v = 0; c.done = true; }
      else { v = Math.max(v, 0.6); c.s = Math.min(r.stopAt, r.total, c.s + (v / r.k) * dt); if (c.s >= r.total) c.done = true; }
      c.v = v;
    }
    if (c && this.cam) this.camera(dt);
    this.onFrame?.(dt, realDt);
    if (this.map) this.updateLabels();
  }
  // the app's camFrame + junction view (app.js), with the car on the route instead of the game's position
  camera(dt) {
    const c = this.car, r = c.route, cam = this.cam, map = this.map;
    const pos = r.pos(c.s), heading = r.heading(c.s);
    const kk = cam.snap ? 1 : 1 - Math.exp(-dt * 8);
    cam.bearing = cam.snap ? heading : (cam.bearing + angleDiff(cam.bearing, heading) * kk + 360) % 360;
    cam.speed = cam.snap ? c.v : cam.speed + (c.v - cam.speed) * (1 - Math.exp(-dt * 1.6));
    this.truck.setLngLat(pos).setRotation(cam.bearing);
    // junction: zoom in `lead` seconds before a maneuver worth it, fitting car + junction in view
    const nav = r.nav(c.s);
    this.nav = nav;
    const info = nav ? junctionInfo(nav) : null;
    const secs = nav ? nav.toNext / Math.max(c.v, 4) : Infinity;
    const lead = 15 * (info?.busy ? 1.4 : 1);
    const approaching = !!info && (secs <= lead || nav.toNext <= 80);
    const jx = cam.jx;
    if (nav && nav.i !== jx.step) jx.step = nav.i;
    jx.active = approaching;
    const base = speedZoom(cam.speed);
    if (jx.active) {
      const d = Math.max(metres(pos, r.pos(nav.n.at)), 6), lat = pos[1] * RAD;
      const z = Math.log2((GEO_MPP_Z0 * Math.cos(lat)) / (d / (cam.h * 0.6)));
      jx.target = Math.min(Math.max(z, base + 0.4), base + 1.3, 16.5);
    } else jx.target = null;
    const zT = jx.active && jx.target != null ? jx.target : base;
    if (cam.zoom == null || cam.snap) cam.zoom = zT;
    else { const rate = 1.1 * dt; cam.zoom += clamp((zT - cam.zoom) * (1 - Math.exp(-dt * 2.5)), -rate, rate); }
    const pT = jx.active ? 40 : 48 + Math.min(1, cam.speed / 30) * 12;
    cam.pitch += (pT - cam.pitch) * (cam.snap ? 1 : 1 - Math.exp(-dt * 3));
    map.jumpTo({ center: pos, zoom: cam.zoom, bearing: cam.bearing, pitch: cam.pitch, padding: { top: Math.round(cam.h * 0.44), bottom: 0, left: 0, right: 0 } });
    cam.snap = false;
    if (this.hazeNight !== this.night) { this.hazeNight = this.night; this.haze.style.background = `linear-gradient(${this.night ? '#1a1a1a' : '#f8f8f8'} 0%, transparent 100%)`; }
    this.haze.style.opacity = (clamp((cam.pitch - 30) / 30, 0, 1) * 0.9).toFixed(2);
    // banner: next maneuver, brighter + progress bar while approaching, lanes, "then"
    if (this.banner && !this.bannerOff) this.banner.hidden = !nav;
    if (nav && this.banner) {
      const d = Number(nav.n.d), b = this.banner;
      b.querySelector('.arrow').textContent = dirArrow(d);
      b.querySelector('.navDist').textContent = fmtDist(nav.toNext);
      b.querySelector('.navWhat').textContent = [dirText(d, nav.n.exit), nav.n.b].filter(Boolean).join(' · ');
      b.classList.toggle('near', approaching && secs > 6); b.classList.toggle('now', approaching && secs <= 6);
      b.querySelector('.navProgress i').style.width = approaching ? Math.round(clamp(1 - secs / lead, 0, 1) * 100) + '%' : '0';
      const then = nav.after && nav.toNext < 500 ? Number(nav.after.d) : null;
      const tEl = b.querySelector('.navThen');
      tEl.hidden = then == null || then === 0 || then === -1;
      if (!tEl.hidden) tEl.querySelector('span').textContent = dirArrow(then);
      const lanes = nav.n.lanes, ls = b.querySelector('.laneStrip');
      const showL = !!lanes && lanes.length >= 2 && !(lanes.every(l => l.active != null) && d === 0) && (approaching || nav.toNext < 1500);
      if (showL) { const key = JSON.stringify(lanes); if (ls.dataset.key !== key) { ls.dataset.key = key; ls.innerHTML = lanes.map(l => `<div class="lane ${l.active != null ? 'use' : ''}">${laneSvg(l.branches, l.active)}</div>`).join(''); } }
      ls.hidden = !showL;
    }
    // instruments, if this stage has them
    if (this.gauges) this.gauges(c.v, dt);
  }
}
function h_(parent, tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; parent?.appendChild(e); return e; }
const SPEED_ZOOM = [[0, 15.0], [6, 14.5], [12, 13.4], [18, 12.4], [24, 11.7], [30, 11.1], [40, 10.5]];
function speedZoom(v) {
  for (let i = 0; i < SPEED_ZOOM.length - 1; i++) { const [v0, z0] = SPEED_ZOOM[i], [v1, z1] = SPEED_ZOOM[i + 1]; if (v <= v1) return z0 + ((Math.max(v, v0) - v0) / (v1 - v0)) * (z1 - z0); }
  return SPEED_ZOOM[SPEED_ZOOM.length - 1][1];
}
// the app's "is this maneuver worth zooming in for"
function junctionInfo(nav) {
  const d = Number(nav.n.d);
  if (d === -2 || d === -4) return null;
  const lanes = nav.n.lanes || [];
  const laneChoice = lanes.length >= 2 && lanes.some(l => l.active == null);
  const chained = !!nav.after && Number(nav.after.d) !== 0 && nav.stepDist < 600;
  const busy = lanes.length >= 3 || chained || (d >= 21 && d <= 29);
  if (d === 0 && !laneChoice && !busy) return null;
  if (d === -1) return null;
  return { busy, chained };
}
const route_pos = c => c.route.pos(c.s);
function nearestAlong(route, p) {
  const kx = Math.cos(p[1] * RAD) * 111320, ky = 110540;
  let best = { s: 0, d: Infinity };
  for (let i = 0; i < route.pts.length - 1; i++) {
    const a = route.pts[i], b = route.pts[i + 1];
    const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky, L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? clamp(-(ax * dx + ay * dy) / L2, 0, 1) : 0;
    const d = Math.hypot(ax + dx * t, ay + dy * t);
    if (d < best.d) best = { s: route.cum[i] + t * (route.cum[i + 1] - route.cum[i]), d };
  }
  return best.s;
}

// console instruments (speedometer, rev ring, fuel) driven by the car's speed
function addInstruments(st, { fuelPct = 64, rangeMi = 296, delivery } = {}) {
  st.console.innerHTML = `<div class="cluster">${speedoHtml()}${revsHtml()}${fuelHtml()}${telltalesHtml()}</div><div class="side">${delivery ? deliveryHtml(JOB) : ''}</div>`;
  const big = st.console.querySelector('.speedo .big'), val = st.console.querySelector('.speedo .val'), cc = st.console.querySelector('.speedo .cc');
  const gear = st.console.querySelector('.revs .gear'), rpmT = st.console.querySelector('.revs .rpm'), rv = st.console.querySelector('.revs .val');
  const fuel = st.console.querySelector('.fuelG');
  st.fuel = { pct: fuelPct, range: rangeMi };
  const tt = n => st.console.querySelector(`[data-tt="${n}"]`);
  tt('lowbeam').classList.add('on'); tt('cruise').classList.add('on');
  st.gauges = v => {
    const mph = Math.round(v * 2.23694);
    big.textContent = mph; val.style.strokeDashoffset = (SPEEDO_LEN * (1 - clamp(mph / 90, 0, 1))).toFixed(1) + 'px';
    cc.textContent = mph >= 58 ? 'CC 60' : '';
    tt('cruise').classList.toggle('on', mph >= 58);
    const g = v < 0.3 ? 'N' : Math.min(6, 1 + Math.floor(v / 4.6));
    const rpm = v < 0.3 ? 800 : 1100 + ((v % 4.6) / 4.6) * 1500 + (g === 6 ? (v - 23) * 60 : 0);
    gear.textContent = g; rpmT.textContent = `${(rpm / 1000).toFixed(1)}k rpm`; rv.style.strokeDashoffset = (REV_LEN * (1 - clamp(rpm / 5800, 0, 1))).toFixed(1) + 'px';
    fuel.querySelector('b').textContent = `${Math.round(st.fuel.range)} mi`; fuel.querySelector('.sub').textContent = Math.round(st.fuel.pct) + '%';
    fuel.querySelectorAll('.segs i').forEach((s, i) => s.classList.toggle('on', st.fuel.pct > i * 10 + 2));
    fuel.classList.toggle('low', st.fuel.pct <= 25); fuel.classList.toggle('crit', st.fuel.pct <= 10);
    tt('fuel').classList.toggle('on', st.fuel.pct <= 25);
  };
}

// ---------------------------------------------------------------- scenes
const SCENES = {
  // Hero: the whole app on a tablet, CA-99 into Fresno at 60 mph, the junction view at the exit,
  // off the freeway and through town, with the delivery card counting down.
  hero: {
    size: { w: 1280, h: 800, layout: 'tablet' }, data: 'hero',
    async setup(st, d) {
      st.main = new Route(d.routes.main);
      addInstruments(st, { delivery: true });
      st.timeScale = 1.25;
    },
    async play(st) {
      const r = st.main, card = st.console.querySelector('.deliveryCard');
      const endAt = Math.min(r.total, (r.steps.find(s => s.d === '2')?.at ?? r.total * 0.65) + 2600);
      st.drive(r, { v0: 26.8, keepGoing: true });
      st.showRoute(r);
      const total = 106.4 * 1609.34, pinJob = st.pin(r.pos(r.total), { kind: 'job', final: true, drop: false });
      st.onFrame = () => {
        const left = (r.total - st.car.s) * r.k * 20 + 1200;        // game distance still to drive (×20 like the job)
        const p = clamp(1 - left / total, 0, 1);
        card.querySelector('.pbar i').style.width = (p * 100).toFixed(1) + '%';
        card.querySelector('.pct').textContent = Math.floor(p * 100) + '%';
        card.querySelector('.pleft').textContent = `${Math.round(left / 1609.34)} mi to go`;
        const etaMin = 17 * 60 + 2 + (left / 1609.34) * 0.92, arr = `${Math.floor(etaMin / 60)}:${String(Math.round(etaMin % 60)).padStart(2, '0')} PT`;
        card.querySelector('.arr').textContent = arr; card.querySelector('.tEta').textContent = 'arrive ' + arr;
        card.querySelector('.arrIn').textContent = `in ${fmtDur((left / 1609.34) * 0.92)}`;
        card.querySelector('.stSub').textContent = `${fmtDur(20 * 60 + 16 - etaMin)} to spare`;
        card.querySelector('.left').textContent = `${fmtDur(20 * 60 + 16 - (17 * 60 + 2))} left`;
      };
      await st.fade(false);
      await st.until(() => st.car.s >= endAt);
      await st.fade(true);
      pinJob.remove();
    },
  },

  // Junction: Los Angeles, a busy interchange ("keep right, then keep left"). The camera zooms in
  // 21 s before it (15 s at simpler junctions), shows the lanes, then glides back out.
  junction: {
    size: { w: 1024, h: 640 }, data: 'junction',
    async setup(st, d) { st.main = new Route(d.routes.main); st.timeScale = 1.15; },
    async play(st) {
      const r = st.main;
      st.drive(r, { v0: 26.8, keepGoing: true });
      st.showRoute(r);
      const split = r.steps.find(s => s.lanes?.length >= 3) ?? r.steps[0];
      let phase = 0;
      st.onFrame = () => {
        const nav = st.nav;
        if (phase === 0 && st.car.s > 300) { st.chip('Highway: <b>far out</b>, tilted to see the road ahead'); phase = 1; }
        if (phase === 1 && nav && st.cam.jx.active) { st.chip(`Busy junction in <b>${Math.round(nav.toNext / Math.max(st.car.v, 4))} s</b>, zooming in`); phase = 2; }
        if (phase === 2 && nav && nav.toNext < 260) { const l = spokenLanes(nav.n.lanes); st.chip(l ? `Lanes: <b>${l}</b>` : 'Lanes shown on the banner'); phase = 3; }
        if (phase === 3 && st.car.s > split.at + 1500) { st.chip('Past the split: <b>back out</b> at speed'); phase = 4; }
      };
      await st.fade(false);
      await st.until(() => st.car.s >= r.total - 400 || st.car.done);
      st.chip(null);
      await st.fade(true);
    },
  },

  // Voice: Long Beach, an early call on the freeway (with lanes), a final call right before, and one
  // call per turn in town; quiet stretches are fast-forwarded.
  voice: {
    size: { w: 1024, h: 640 }, data: 'voice',
    async setup(st, d) { st.main = new Route(d.routes.main); },
    async play(st) {
      const r = st.main;
      st.drive(r, { v0: 26.8, keepGoing: true });
      st.showRoute(r);
      const spoken = new Set(); let speaking = false, lastSpoke = -1e9, queue = null;
      st.onFrame = () => {
        const nav = st.nav, c = st.car;
        if (!nav || speaking) return;
        const d = Number(nav.n.d);
        if (d === 0 || d === -1) return;
        const speed = Math.max(c.v, 3), highway = speed > 18, key = s => `${nav.i}:${s}`;
        const chained = !!nav.after && nav.stepDist < 300 && ![0, -1, -2].includes(Number(nav.after.d));
        const thenTxt = chained ? `, then ${spokenTurn(Number(nav.after.d))}` : '';
        const what = d === -3 ? `you will arrive at ${nav.n.b || 'your destination'}` : spokenTurn(d);
        const lanes = spokenLanes(nav.n.lanes);
        const finalAt = highway ? Math.max(120, speed * 6) : Math.max(50, speed * 8);
        if (nav.toNext <= finalAt && !spoken.has(key('final'))) {
          spoken.add(key('final')); spoken.add(key('early'));
          if (chained) { spoken.add(`${nav.i + 1}:early`); if (nav.stepDist < 150) spoken.add(`${nav.i + 1}:final`); }
          queue = `In ${spokenDistance(nav.toNext)}, ${what}${thenTxt}.`;
        } else if (highway && nav.toNext <= 2000 && nav.toNext > Math.max(700, finalAt * 3) && !spoken.has(key('early')) && performance.now() - lastSpoke > 5000) {
          spoken.add(key('early'));
          queue = `In ${spokenDistance(nav.toNext)}, ${what}${lanes ? `. ${capFirst(lanes)}` : ''}.`;
        }
        // fast-forward while nothing is said and nothing is coming up for a while
        const soon = nav.toNext / Math.max(c.v, 4) < (highway ? 9 : 10);
        st.timeScale = queue || soon ? 1 : 3;
        st.ffEl.classList.toggle('show', st.timeScale > 1);
      };
      await st.fade(false);
      // end a few seconds after the town turns (early call, final call and a "…, then turn" call heard)
      const turns = r.steps.filter(s => s.d === '12' || s.d === '2');
      const endAt = Math.min(r.total - 300, (turns[1] ?? turns[0] ?? { at: r.total })?.at + 2600);
      while (st.car.s < endAt && !st.car.done) {
        await st.until(() => queue || st.car.s >= endAt || st.car.done);
        if (queue) { const t = queue; queue = null; speaking = true; st.timeScale = 1; st.ffEl.classList.remove('show'); await st.say(t); speaking = false; lastSpoke = performance.now(); }
      }
      await st.fade(true);
    },
  },

  // Stops: long-press to add a stop, a closer one becomes number 1, hold a pin to remove it, the
  // route is recalculated each time (all four routes are real, from the app's router).
  stops: {
    size: { w: 1024, h: 640 }, data: 'stops',
    async setup(st, d) {
      st.R = Object.fromEntries(Object.entries(d.routes).map(([k, v]) => [k, new Route(v)]));
      st.P = d.points;
    },
    async play(st) {
      const { A, B, C, D } = st.R, map = st.map;
      st.banner.hidden = true;
      // overview, north-up, like browsing the map in the app, framed on town, where the stops are
      const exitAt = A.steps.find(s => s.d === '11' || s.d === '12')?.at ?? 0;
      const all = [st.P.P1, st.P.P2, ...A.pts.filter((_, i) => A.cum[i] > exitAt - 6000), ...C.pts.filter((_, i) => C.cum[i] > exitAt - 6000)];
      const bb = all.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [180, 90, -180, -90]);
      map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: { top: 70, bottom: 60, left: 90, right: 90 }, duration: 0, bearing: 0, pitch: 0 });
      st.updateLabels(true);
      st.truck.setLngLat(A.pts[0]).setRotation(A.heading(0));
      if (!st.truckOn) { st.truck.addTo(map); st.truckOn = true; }
      st.showRoute(null); st.map.getSource('routeOld').setData(empty());
      st.clearPins();
      const job = st.pin(A.pts[A.pts.length - 1], { kind: 'job', final: true });
      await st.fade(false);
      await st.drawRoute(A, 1100);
      await st.wait(900);
      const press = async (ll, label) => {
        const p = map.project(ll);
        st.chip(label);
        st.tap(p.x, p.y, true);
        await st.wait(900);
      };
      const reroute = async (from, to) => { st.map.getSource('routeOld').setData(from.geo()); st.showRoute(null); await st.drawRoute(to, 1000); st.map.getSource('routeOld').setData(empty()); };
      // 1) long-press → "Add as stop" → pin 1, route via it
      await press(st.P.P1, `Long-press the map: <b>Add as stop</b>`);
      const p1 = st.pin(st.P.P1, { n: 1 });
      await reroute(A, B);
      await st.wait(1300);
      // 2) a closer point → it becomes stop 1, the other moves to 2
      await press(st.P.P2, 'A closer stop becomes <b>number 1</b>');
      const p2 = st.pin(st.P.P2, { n: 1, kind: 'fuel' });
      p1.set('2');
      await reroute(B, C);
      await st.wait(1500);
      // 3) hold a pin → remove it
      st.chip('Hold a pin to <b>remove</b> it');
      const q = map.project(st.P.P1);
      st.tap(q.x, q.y - 22, true); p1.el.classList.add('held');
      await st.wait(900);
      p1.el.classList.add('gone'); await st.wait(350); p1.remove();
      await reroute(C, D);
      st.chip('Route updated, the job stays last');
      await st.wait(2200);
      st.chip(null);
      await st.fade(true);
      p2.remove(); job.remove();
    },
  },

  // Smart stops: fuel low / rest timer / damage → the stop with the least detour, one tap to add it.
  // Each loop shows the next kind; stations and detours are the app's real picks.
  suggest: {
    size: { w: 1024, h: 640 }, data: 'suggest',
    async setup(st, d) {
      st.variants = ['fuel', 'rest', 'service'].filter(k => d.variants[k]).map(k => ({ kind: k, ...d.variants[k], B: new Route(d.variants[k].before), V: new Route(d.variants[k].via) }));
      st.vi = 0;
    },
    async play(st) {
      const v = st.variants[st.vi++ % st.variants.length];
      st.setMap(v.map);
      st.clearPins(); st.map.getSource('routeOld').setData(empty());
      st.drive(v.B, { v0: 26.8, keepGoing: true });
      st.showRoute(v.B);
      const quickBtn = st.quick.querySelector(`.w.btn.${v.kind}`);
      st.quick.querySelectorAll('.w.btn').forEach(b => b.classList.remove('on'));
      await st.fade(false);
      await st.wait(2600);
      // the suggestion, as the app shows it
      const det = v.detour == null ? '' : v.detour < 90 ? 'on your way' : `+${Math.max(1, Math.round(v.detour / 60))} min detour`;
      const T = {
        fuel: [`${icon('fuel')} Fuel 18 %, 41 mi left`, 'Easiest fuel to add to your route'],
        rest: [`${icon('bed')} Rest needed in 1 h 40 min`, 'Easiest rest area to add to your route'],
        service: [`${icon('wrench')} Damage 14 %, engine`, 'Easiest mechanic to add to your route'],
      }[v.kind];
      st.sheet.innerHTML = `<div class="sheetTitle">${T[0]}</div><div class="muted">${T[1]}</div><div class="sugStop">${v.name}</div>
        <div class="muted">${det}${v.kind === 'rest' ? '' : ''}</div>${v.kind === 'rest' ? '<div class="allow">You can rest up to 2 h 10 min and still arrive on time</div>' : ''}
        <div class="row"><div class="b go">＋ Add to route</div><div class="b">Not now</div></div>`;
      st.sheet.classList.add('show');
      quickBtn?.classList.add('on');
      await st.wait(2600);
      st.tapEl(st.sheet.querySelector('.b.go'));
      await st.wait(350);
      st.sheet.classList.remove('show');
      // route via the station: the old one fades, the new one is drawn
      st.switchRoute(v.V);
      const stop = v.V.stops.find(s => !s.final);
      st.pin(stop.ll, { n: 1, kind: v.kind });
      st.map.getSource('routeOld').setData(v.B.geo());
      st.showRoute(v.V);
      st.toast(`Stop 1 added: ${v.name}`, 2000);
      await st.wait(1400);
      st.map.getSource('routeOld').setData(empty());
      const exit = v.V.steps.find(s => s.at > st.car.s && ['11', '12', '1', '2'].includes(s.d));
      const endAt = Math.min((exit?.at ?? st.car.s + 8000) + 5200, v.V.total - 100);
      await st.until(() => st.car.s >= endAt || st.car.done);
      await st.fade(true);
      st.clearPins();
    },
  },

  // Delivery: into Fresno to Aron, the delivery card counts down to 100 %, then the big Deliver button.
  delivery: {
    size: { w: 1024, h: 640, layout: 'side' }, data: 'hero',
    async setup(st, d) {
      st.main = new Route(d.routes.main);
      st.console.innerHTML = `<div class="side" style="padding-top:12px">${deliveryHtml(JOB)}</div>`;
      st.quick.style.display = 'none';
    },
    async play(st) {
      const r = st.main, card = st.console.querySelector('.deliveryCard');
      card.dataset.state = 'ok';
      const from = Math.max(0, r.total - 9000);
      st.drive(r, { from, v0: 13, stopAt: r.total });
      st.showRoute(r);
      const job = st.pin(r.pos(r.total), { kind: 'job', final: true, drop: false });
      const total = 106.4 * 1609.34;
      st.onFrame = () => {
        const left = (r.total - st.car.s) * r.k * 20;
        const p = clamp(1 - left / total, 0, 1);
        card.querySelector('.pbar i').style.width = (p * 100).toFixed(1) + '%';
        card.querySelector('.pct').textContent = Math.floor(p * 100) + '%';
        card.querySelector('.pleft').textContent = left > 300 ? `${(left / 1609.34).toFixed(1)} mi to go` : 'arriving';
        const eta = 17 * 60 + 12 + (left / 1609.34) * 1.6, arr = `${Math.floor(eta / 60)}:${String(Math.round(eta % 60)).padStart(2, '0')} PT`;
        card.querySelector('.arr').textContent = arr; card.querySelector('.tEta').textContent = 'arrive ' + arr;
        card.querySelector('.arrIn').textContent = `in ${fmtDur((left / 1609.34) * 1.6)}`;
        card.querySelector('.stTitle').textContent = 'On time';
        card.querySelector('.stSub').textContent = `${fmtDur(20 * 60 + 16 - eta)} to spare`;
        card.querySelector('.left').textContent = '3h 4m left';
        const etaPct = 30 + p * 6;
        card.querySelector('.mk.eta').style.left = etaPct + '%'; card.querySelector('.tEta').style.left = etaPct + '%';
      };
      await st.fade(false);
      await st.until(() => st.car.done);
      st.onFrame = null;
      card.querySelector('.pbar i').style.width = '100%'; card.querySelector('.pct').textContent = '100%'; card.querySelector('.pleft').textContent = 'arrived';
      // stopped at the company: the app's Enter button
      st.prompt.dataset.kind = 'company'; st.prompt.className = 'actionPrompt';
      st.prompt.querySelector('.apIcon').innerHTML = icon('box');
      st.prompt.querySelector('b').textContent = 'Deliver cargo'; st.prompt.querySelector('.apText span').textContent = 'Aron, Fresno';
      st.prompt.querySelector('.apGo').innerHTML = '⏎ Deliver';
      await st.wait(400); st.prompt.classList.add('show');
      await st.wait(1800);
      st.tapEl(st.prompt.querySelector('.apGo'));
      await st.wait(500);
      st.prompt.classList.add('done'); st.prompt.querySelector('.apGo').innerHTML = `${icon('check')} Delivered`;
      card.dataset.state = 'done'; card.querySelector('.stTitle').textContent = 'Delivered on time'; card.querySelector('.stSub').textContent = '+$4,820';
      await st.wait(2200);
      st.prompt.classList.remove('show', 'done');
      await st.fade(true);
      job.remove();
    },
  },

  // Enter helper: off the freeway into the truck stop, stop at the pump, Engine off, Fill up, done.
  enter: {
    size: { w: 1024, h: 640 }, data: 'enter',
    async setup(st, d) {
      const sg = await loadData('suggest');
      const v = sg.variants.fuel;
      st.name = d.name;
      const via = new Route(v.via);
      // the route to the station, then the last metres to the pump itself
      const stop = via.stops.find(s => !s.final);
      const pts = via.slice(stop.at), spot = d.spot;
      const extra = [[lerp(pts[pts.length - 1][0], spot[0], 0.5), lerp(pts[pts.length - 1][1], spot[1], 0.5)], spot];
      const j = { ...v.via, line: pts.flat(), caps: v.via.caps.slice(0, pts.length), steps: v.via.steps.filter(s => s.at < stop.at - 1), stops: [] };
      st.main = new Route(j, extra);
      st.from = Math.max(0, stop.at - 5000);   // a few seconds before the station, already off the freeway
      st.timeScale = 1.6;
      st.quick.style.display = 'none';
      st.fuelBox = h_(st.mapWrap, 'div', 'card', `<div class="gauge bargauge fuelG low" style="min-width:210px"><div class="bgTop">${icon('fuel')}<b>12%</b><span class="sub">fuel</span></div><div class="segs">${'<i></i>'.repeat(10)}</div><div class="bgScale"><span>E</span><span>½</span><span>F</span></div></div>`);
      Object.assign(st.fuelBox.style, { position: 'absolute', left: '10px', bottom: '124px', zIndex: 3, padding: '8px 10px', background: 'var(--map-btn-bg)' });
    },
    async play(st) {
      const r = st.main, fb = st.fuelBox, segs = fb.querySelectorAll('.segs i'), pctEl = fb.querySelector('b');
      const setFuel = p => { pctEl.textContent = Math.round(p) + '%'; segs.forEach((s, i) => s.classList.toggle('on', p > i * 10 + 2)); fb.querySelector('.fuelG').classList.toggle('low', p <= 25); fb.querySelector('.fuelG').classList.toggle('crit', p <= 10); };
      setFuel(12);
      st.drive(r, { from: st.from, v0: 13, stopAt: r.total });
      st.showRoute(r);
      await st.fade(false);
      await st.until(() => st.car.done);
      st.bannerOff = true; st.banner.hidden = true;
      st.showRoute(null);                     // parked at the pump: the station itself is what matters now
      const P = st.prompt, go = P.querySelector('.apGo');
      P.dataset.kind = 'fuel'; P.className = 'actionPrompt engine';
      P.querySelector('.apIcon').innerHTML = icon('fuel');
      P.querySelector('b').textContent = 'Engine off first'; P.querySelector('.apText span').textContent = `to refuel · ${st.name}`;
      go.innerHTML = `${icon('power')} Engine off`;
      await st.wait(300); P.classList.add('show');
      await st.wait(1700);
      st.tapEl(go);
      await st.wait(700);
      P.classList.remove('engine'); P.querySelector('b').textContent = 'Refuel'; go.innerHTML = '⛽ Fill up';
      await st.wait(1300);
      st.tapEl(go);
      await st.wait(300);
      P.querySelector('b').textContent = 'Filling up…'; go.innerHTML = '■ Stop';
      const t0 = performance.now();
      while (performance.now() - t0 < 3600 / SPEED) { const t = (performance.now() - t0) * SPEED / 3600; setFuel(12 + ease(t) * 88); await st.frame(); }
      setFuel(100);
      P.classList.add('done'); P.querySelector('b').textContent = 'Fuel 100 %'; go.innerHTML = `${icon('check')} Full`;
      await st.wait(2000);
      P.classList.remove('show', 'done');
      await st.fade(true);
      st.bannerOff = false;
    },
  },

  // Your cab: Customize, switches wiggle, one is dragged from the drawer into the dock, then day/night.
  custom: {
    size: { w: 1024, h: 640, dock: true }, data: 'hero',
    async setup(st, d) {
      st.main = new Route(d.routes.main);
      // a shorter dock for this screen size
      st.dock.innerHTML = DOCK.slice(0, 9).map(([ic, l, on]) => btnHtml(ic, l, on ?? '')).join('');
      st.drawer = h_(st.mapWrap, 'div', 'drawer', btnHtml('radio', 'Radio') + btnHtml('horn', 'Horn') + btnHtml('beacon', 'Beacon') + btnHtml('camera', 'Park cams') + btnHtml('highbeam', 'High beam') + btnHtml('power', 'Electrics'));
      st.editBar = h_(st.mapWrap, 'div', 'editBar', '<span>＋ Add</span><span>Reset</span><span class="pri">Done</span>');
      st.timeScale = 1;
    },
    async play(st) {
      const r = st.main;
      const from = r.steps.find(s => s.d === '-1')?.at ?? r.total * 0.5;
      st.drive(r, { from, v0: 18 });
      st.showRoute(r);
      await st.fade(false);
      await st.wait(1600);
      // Customize mode
      const edit = st.mapButtons.querySelector('.edit');
      st.tapEl(edit); edit.classList.add('on');
      await st.wait(300);
      st.root.querySelectorAll('.dock .w.btn, .quick .w.btn').forEach(b => b.classList.add('edit'));
      st.editBar.classList.add('show');
      await st.wait(900);
      st.tapEl(st.editBar.querySelector('span'));
      st.drawer.classList.add('show');
      await st.wait(900);
      // drag the radio into the dock
      const src = st.drawer.querySelector('[data-b="radio"]');
      const o = st.root.getBoundingClientRect(), sr = src.getBoundingClientRect(), s = st.scale;
      const ghost = h_(st.root, 'div', 'w btn ghost', src.innerHTML);
      Object.assign(ghost.style, { left: (sr.left - o.left) / s + 'px', top: (sr.top - o.top) / s + 'px', width: sr.width / s + 'px', height: sr.height / s + 'px' });
      st.tap((sr.left - o.left + sr.width / 2) / s, (sr.top - o.top + sr.height / 2) / s, true);
      await st.wait(500);
      src.style.opacity = '.3';
      const dock = st.dock.getBoundingClientRect(), last = st.dock.lastElementChild.getBoundingClientRect();
      ghost.style.left = (last.right - o.left) / s + 8 + 'px'; ghost.style.top = (dock.top - o.top) / s + 8 + 'px';
      await st.wait(1000);
      ghost.remove();
      st.dock.insertAdjacentHTML('beforeend', btnHtml('radio', 'Radio', 'on edit'));
      await st.wait(900);
      st.drawer.classList.remove('show');
      st.tapEl(st.editBar.querySelector('.pri'));
      st.root.querySelectorAll('.w.btn.edit').forEach(b => b.classList.remove('edit'));
      st.editBar.classList.remove('show'); edit.classList.remove('on');
      await st.wait(1000);
      // day / night: the map and the whole app switch
      const th = st.mapButtons.querySelector('.theme');
      st.tapEl(th);
      st.night = false; st.root.classList.add('day'); applyTheme(st.map, false); th.innerHTML = icon('sun');
      st.chip('Day theme, or automatic with the <b>game clock</b>');
      await st.wait(2600);
      st.tapEl(th);
      st.night = true; st.root.classList.remove('day'); applyTheme(st.map, true); th.innerHTML = icon('moon');
      st.chip(null);
      await st.wait(1200);
      await st.fade(true);
      st.dock.lastElementChild.remove(); src.style.opacity = '';
    },
  },
};

// ---------------------------------------------------------------- lifecycle: all scenes are built at page load
// (one after another, hero first) and kept; each plays while it is on screen (it starts a little
// before it scrolls in, so it is already moving when you see it) and pauses when it leaves.
const stages = new Map();   // host → { st, ready, visible }
function ensureStage(host, name) {
  let e = stages.get(host);
  if (e) return e;
  const def = SCENES[name];
  e = { name, st: null, ready: null, visible: false };
  stages.set(host, e);
  e.ready = (async () => {
    const data = await loadData(def.data);
    const st = new Stage(host, def.size);
    const m = data.map ?? Object.values(data.variants ?? {})[0]?.map;
    const r0 = data.routes ? Object.values(data.routes)[0] : data.variants ? Object.values(data.variants)[0].before : null;
    await st.init(mapGeo(m), { center: r0 ? [r0.line[0], r0.line[1]] : data.spot, zoom: 12 });
    st.setMap(m);
    await def.setup(st, data);
    e.st = st;
    return st;
  })();
  return e;
}
const io = new IntersectionObserver(entries => {
  for (const en of entries) {
    const host = en.target, name = host.dataset.scene;
    const e = ensureStage(host, name);
    e.visible = en.isIntersecting;
    if (en.isIntersecting) e.ready.then(st => { if (e.visible) st.start(SCENES[name].play); }).catch(err => console.error(name, err));
    else e.st?.stop();
  }
}, { rootMargin: '500px 0px', threshold: 0 });
// a scene that scrolls away cancels its pending waits with 'stop', expected, not an error
window.addEventListener('unhandledrejection', e => { if (e.reason === 'stop') e.preventDefault(); });
function boot() {
  if (!window.maplibregl) { setTimeout(boot, 50); return; }
  const hosts = Object.keys(SCENES).map(name => [name, document.getElementById('scene-' + name)]).filter(([, h]) => h);
  for (const name of new Set(Object.values(SCENES).map(s => s.data))) loadData(name);   // all data at once
  for (const [name, host] of hosts) { host.dataset.scene = name; io.observe(host); }
  // build every scene now, one after another, so none is still loading when you scroll to it
  (async () => { for (const [name, host] of hosts) { try { await ensureStage(host, name).ready; } catch (err) { console.error(name, err); } } })();
}
boot();
