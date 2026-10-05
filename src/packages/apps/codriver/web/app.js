// ATS Co-Driver dashboard client. Talks to the Co-Driver server (same origin) over HTTP + WebSocket.
'use strict';

const $ = id => document.getElementById(id);
const store = {
  get: (k, d) => { try { const v = localStorage.getItem('dl.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('dl.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

let settings = null;
let route = null;
let last = null;          // last state message
let ws = null;
let follow = true;
let headingUp = store.get('headingUp', true);
let reverseCamAuto = false;
let lastSpeedAlert = 0;

// ------------------------------------------------------------------ units & formatting

const imperial = () => !settings || settings.units !== 'metric';
const fmtSpeed = ms => Math.round(Math.abs(ms) * (imperial() ? 2.23694 : 3.6));
const speedUnit = () => (imperial() ? 'mph' : 'km/h');
function fmtDist(m) {
  if (m == null) return '–';
  if (imperial()) {
    const mi = m / 1609.34;
    return mi < 0.2 ? `${Math.round(m * 3.28084 / 50) * 50} ft` : `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
  }
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}
function fmtDur(s) {
  if (s == null || !isFinite(s)) return '–';
  const t = Math.round(s / 60), h = Math.floor(t / 60), m = t % 60;   // round first: never "2 h 60 min"
  return h ? `${h} h ${m} min` : `${m} min`;
}
const money = v => (v == null ? '–' : '$' + Number(v).toLocaleString());
// Compact form for small gauge tiles: "5h 0m" / "42m".
function fmtDurShort(s) {
  if (s == null || !isFinite(s)) return '–';
  const t = Math.round(s / 60), h = Math.floor(t / 60), m = t % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

// ------------------------------------------------------------------ map

const DIR = { 0: '↑', 1: '↗', 2: '←', 3: '↙', 4: '↶', 11: '↗', 12: '→', 13: '↘', 14: '↷', 29: '↗', '-1': '⤴', '-2': '↑', '-3': '🏁', '-4': '⛴' };
const DIR_TEXT = { 0: 'Continue', 1: 'Keep left', 2: 'Turn left', 3: 'Sharp left', 4: 'U-turn', 11: 'Keep right', 12: 'Turn right', 13: 'Sharp right', 14: 'U-turn', 29: 'Exit the roundabout', '-1': 'Merge', '-2': 'Start', '-3': 'Arrive', '-4': 'Take the ferry' };
const dirArrow = d => DIR[d] ?? (d >= 21 && d <= 28 ? '⟳' : '↑');
const dirText = (d, exit) => (d >= 21 && d <= 28 ? `Roundabout, take exit ${exit ?? ''}` : DIR_TEXT[d] ?? 'Continue');

// ------------------------------------------------------------------ junction view (lanes + auto-zoom)

// Lane arrow angle in degrees, 0 = straight on, negative = left (BranchType numbers from the router).
const BRANCH_ANGLE = { 0: 0, '-1': 0, 1: -45, 2: -90, 3: -135, 4: -180, 11: 45, 12: 90, 13: 135, 14: 180 };
function branchPath(b) {
  const a = BRANCH_ANGLE[b] ?? 0;
  // U-turns: up, over and back down.
  if (Math.abs(a) === 180) {
    return a < 0 ? { d: 'M20 38 V17 A6 6 0 0 0 8 17 V26', end: [8, 28], dir: [0, 1] }
                 : { d: 'M12 38 V17 A6 6 0 0 1 24 17 V26', end: [24, 28], dir: [0, 1] };
  }
  const r = (a * Math.PI) / 180, u = [Math.sin(r), -Math.cos(r)];
  const len = Math.abs(a) >= 135 ? 11 : Math.abs(a) === 90 ? 11 : 15;   // keep the arrowhead inside the 32 px box
  const end = [16 + u[0] * len, 22 + u[1] * len];
  return { d: `M16 38 V22 L${end[0].toFixed(1)} ${end[1].toFixed(1)}`, end, dir: u };
}
function laneSvg(branches, active) {
  // Draw the branches this lane does NOT lead to first (dim), the one to take last (bright).
  const order = [...new Set(branches)].sort((a, b) => (a === active) - (b === active));
  return `<svg viewBox="0 0 32 40" fill="none" stroke-linecap="round" stroke-linejoin="round">${order.map(b => {
    const { d, end, dir } = branchPath(b);
    const col = b === active ? '#fff' : '#ffffff55';
    const n = [-dir[1], dir[0]];
    const tip = [end[0] + dir[0] * 3, end[1] + dir[1] * 3];
    const head = [[tip[0], tip[1]], [end[0] - dir[0] * 4 + n[0] * 5, end[1] - dir[1] * 4 + n[1] * 5], [end[0] - dir[0] * 4 - n[0] * 5, end[1] - dir[1] * 4 - n[1] * 5]];
    return `<path d="${d}" stroke="${col}" stroke-width="3.5"/><polygon points="${head.map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')}" fill="${col}"/>`;
  }).join('')}</svg>`;
}
function renderLanes(n, show) {
  const lanes = n?.lanes;
  const el = $('laneStrip');
  if (!show || !lanes || lanes.length < 2 || lanes.every(l => l.active != null && Number(n.direction) === 0)) { el.hidden = true; el.dataset.key = ''; return; }
  const key = JSON.stringify(lanes);
  if (el.dataset.key !== key) {   // only rebuild when the junction changes
    el.dataset.key = key;
    el.innerHTML = lanes.map(l => `<div class="lane ${l.active != null ? 'use' : ''}">${laneSvg(l.branches, l.active)}</div>`).join('');
  }
  el.hidden = false;
}

// Is the next maneuver worth zooming in for? Plain "continue" on a simple road is not; turns,
// exits, roundabouts, lane splits and maneuvers that follow each other closely (interchange ramps)
// are. `busy` junctions get a longer lead time.
const isRoundabout = d => d >= 21 && d <= 29;
function junctionInfo(nav) {
  const n = nav?.next;
  if (!n) return null;
  const d = Number(n.direction);
  if (d === -2 || d === -4) return null;
  const lanes = n.lanes || [];
  const laneChoice = lanes.length >= 2 && lanes.some(l => l.active == null);
  const chained = nav.after && Number(nav.after.direction) !== 0 && (n.distance ?? Infinity) < 600;
  const busy = lanes.length >= 3 || chained || isRoundabout(d);
  if (d === 0 && !laneChoice && !busy) return null;
  return { busy, chained };
}

// Junction state: active while approaching the current next-maneuver; remembers the zoom the
// driver had so it can return to it after the junction.
const jx = { step: -1, active: false, userZoom: null, target: null, manual: -1, buzzed: -1, lastT: 0 };
const GEO_MPP_Z0 = 78271.517;   // MapLibre metres-per-pixel at zoom 0 at the equator (512 px tiles)
function geoMetres(a, b) {
  const k = Math.PI / 180, dLat = (b[1] - a[1]) * k, dLng = (b[0] - a[0]) * k * Math.cos(((a[1] + b[1]) / 2) * k);
  return Math.sqrt(dLat * dLat + dLng * dLng) * 6371000;
}
function updateJunction(s) {
  const nav = s.nav, speed = Math.abs(s.ch?.['truck.speed'] ?? 0);
  const cfg = settings?.junction ?? { autoZoom: true, leadSec: 15, lanes: true, vibrate: true };
  const info = !nav || nav.offRoute ? null : junctionInfo(nav);
  // Time to the maneuver at the current speed; below ~15 km/h use a floor so crawling in town
  // still zooms in a sensible distance before the turn.
  const secs = nav ? nav.toNext / Math.max(speed, 4) : Infinity;
  const lead = (cfg.leadSec ?? 15) * (info?.busy ? 1.4 : 1);
  const approaching = !!info && (secs <= lead || nav.toNext <= 80);
  if (nav && nav.nextIndex !== jx.step) { jx.step = nav.nextIndex; jx.manual = -1; }
  // (the camera glides to jx.target while active and back to the speed zoom afterwards)
  jx.active = approaching && cfg.autoZoom && jx.manual !== jx.step;
  if (!jx.active) jx.target = null;

  // Zoom so the car and the junction are both on screen, closer as the car gets nearer.
  if (jx.active && s.lngLat && nav.next?.lngLat) {
    const d = Math.max(geoMetres(s.lngLat, nav.next.lngLat), 6);
    const h = map.getContainer().clientHeight;
    const lat = s.lngLat[1] * Math.PI / 180;
    // the junction should sit roughly between the car (lower part of the screen) and the top
    // gentle: fit the junction in the top ~60 % of the screen, at most ~1.3 levels closer than normal
    const z = Math.log2((GEO_MPP_Z0 * Math.cos(lat)) / (d / (h * 0.6)));
    jx.target = Math.min(Math.max(z, cam.baseZoom + 0.4), cam.baseZoom + 1.3, 16.5);
  }

  // Banner: brighter + progress bar while approaching; short buzz ~7 s before the turn.
  const banner = $('navBanner');
  banner.classList.toggle('near', approaching && secs > 6);
  banner.classList.toggle('now', approaching && secs <= 6);
  $('navProgressBar').style.width = approaching ? Math.round(Math.min(1, Math.max(0, 1 - secs / lead)) * 100) + '%' : '0';
  if (info && cfg.vibrate && secs <= 7 && speed > 3 && jx.buzzed !== jx.step) { jx.buzzed = jx.step; navigator.vibrate?.([80, 60, 80]); }
  renderLanes(nav?.next, cfg.lanes && !nav?.offRoute && (approaching || nav?.toNext < 1500));

  // "then ↰" when another maneuver follows right after this one
  const after = nav?.after, then = after && (nav.next?.distance ?? Infinity) < 500 ? Number(after.direction) : null;
  $('navThen').hidden = then == null || then === 0 || !!nav?.offRoute;
  if (then != null) $('navThenArrow').textContent = dirArrow(then);
}

// Map style modelled on the in-game map (palette and widths follow truckermudgeon's GameMapStyle,
// which reproduces the game's map): real road widths with casing, map areas coloured by their
// game colour index, intersections (prefabs) filled, game icons and road shields from the sprite sheet.
// Game sprites come in very different pixel sizes: most company logos are 128×32, a few are tiny
// (e.g. 99×14), and facility icons (dealer, service, recruitment, fuel…) are only 26×26, so one
// multiplier left some icons half the size of others. Each sprite gets a factor that brings it to
// a common visual size; it is filled in once sprites.json has loaded.
let spriteNorm = null;   // { company: matchExpr, facility: matchExpr }
const ICON_ZOOM = {
  company: [[5, 0.7], [9, 1.15], [14, 1.8], [16, 2.1]],
  facility: [[4, 0.85], [8, 1.2], [12, 1.5], [15, 1.8]],
};
function iconSize(kind) {
  const norm = spriteNorm?.[kind];
  return ['interpolate', ['linear'], ['zoom'], ...ICON_ZOOM[kind].flatMap(([z, s]) => [z, norm ? ['*', s, norm] : s])];
}
fetch('/sprites.json').then(r => r.json()).then(sprites => {
  const company = [], facility = [];
  for (const [name, { width: w, height: h }] of Object.entries(sprites)) {
    // logos: match the area of a standard 128×32 logo; small square icons: match a 44 px square
    const c = Math.min(2, Math.max(0.8, Math.sqrt((128 * 32) / (w * h))));
    const f = Math.min(2.4, Math.max(1, 44 / Math.max(w, h)));
    if (Math.abs(c - 1) > 0.05) company.push(name, +c.toFixed(2));
    if (Math.abs(f - 1) > 0.05) facility.push(name, +f.toFixed(2));
  }
  spriteNorm = {
    company: company.length ? ['match', ['get', 'sprite'], ...company, 1] : 1,
    facility: facility.length ? ['match', ['get', 'sprite'], ...facility, 1] : 1,
  };
  applyIconSizes();
}).catch(() => {});
function applyIconSizes() {
  if (!spriteNorm || !map.getLayer('company-icons')) return;
  map.setLayoutProperty('company-icons', 'icon-size', iconSize('company'));
  map.setLayoutProperty('facility-icons', 'icon-size', iconSize('facility'));
}

function mapStyle(night) {
  const mode = night ? 'dark' : 'light';
  const land = night ? '#1a1a1a' : '#f8f8f8';
  // Road colours must contrast with the land colour at every zoom (white-on-white made roads vanish).
  const roadColors = {
    light: { freeway: ['#f5c242', '#c98f1c'], divided: ['#9aa4b1', '#7d8794'], local: ['#b9c0c9', '#98a1ac'] },
    dark: { freeway: ['#b8963e', '#5a4a24'], divided: ['#6b7280', '#3a3f47'], local: ['#4b5059', '#2b2f35'] },
  }[mode];
  const areaColors = {
    light: ['hsl(200,8%,92%)', 'hsl(38,59%,76%)', 'hsl(38,64%,58%)', 'hsl(92,31%,70%)', 'hsl(0,100%,30%)', 'hsl(107,51%,43%)', 'hsl(201,53%,39%)', 'hsl(53,84%,53%)', 'hsl(267,46%,45%)'],
    dark: ['hsl(200,2%,36%)', 'hsl(38,25%,35%)', 'hsl(38,25%,25%)', 'hsl(143,20%,25%)', 'hsl(0,100%,25%)', 'hsl(107,51%,25%)', 'hsl(201,53%,25%)', 'hsl(53,84%,25%)', 'hsl(267,46%,25%)'],
  }[mode];
  const areaColor = ['match', ['get', 'color'], ...areaColors.flatMap((c, i) => [i, c]), areaColors[0]];
  const roadColor = i => ['match', ['get', 'roadType'], 'freeway', roadColors.freeway[i], 'divided', roadColors.divided[i], roadColors.local[i]];
  // Zoomed out, roads need a minimum on-screen width or they vanish; freeways are drawn thickest.
  // Up close, roads are drawn at their true width: the server puts each road's real width (from its
  // lanes, median and shoulders, in map metres) in `w`; px = metres × 2^zoom / ~62 500 at ATS
  // latitudes. A divided highway used to be one thin centre line, so the car and the route (which run
  // on the real carriageway, metres beside that line) looked off the road. Zoomed out, a minimum
  // width keeps every road visible.
  const M2PX = z => Math.pow(2, z) / 62500;
  const trueW = z => ['*', ['coalesce', ['get', 'w'], 300], M2PX(z)];
  const roadWidth = ['interpolate', ['exponential', 2], ['zoom'],
    3, ['match', ['get', 'roadType'], 'freeway', 1.6, 'divided', 1.2, 0.9],
    7, ['match', ['get', 'roadType'], 'freeway', 2.4, 'divided', 1.8, 1.3],
    10, ['max', ['match', ['get', 'roadType'], 'freeway', 3.2, 'divided', 2.6, 2], trueW(10)],
    20, trueW(20)];
  const caseWidth = ['interpolate', ['exponential', 1.5], ['zoom'], 3, 0.5, 8, 1, 14, 2, 16, 3];
  const notSecret = ['!=', ['get', 'secret'], true];   // secret roads stay hidden until discovered, like in game
  // Zoom interpolations must be top-level expressions, so the casing gets its own (wider) curve.
  // the route covers about one and a half lanes of the carriageway (4.5 m lanes × ~19.8 map m per game m)
  const ROUTE_M = 135;
  const routeWidth = ['interpolate', ['exponential', 2], ['zoom'], 5, 3, 10, 6, 12, Math.max(6, ROUTE_M * M2PX(12)), 20, ROUTE_M * M2PX(20)];
  const routeCaseWidth = ['interpolate', ['exponential', 2], ['zoom'], 5, 5, 10, 9, 12, Math.max(9, ROUTE_M * 1.35 * M2PX(12)), 20, ROUTE_M * 1.35 * M2PX(20)];
  return {
    version: 8,
    sprite: location.origin + '/sprites',
    sources: {
      game: { type: 'vector', tiles: [location.origin + '/tiles/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 15 },
      route: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers: [
      { id: 'land', type: 'background', paint: { 'background-color': land } },
      { id: 'mapAreas', type: 'fill', source: 'game', 'source-layer': 'areas', filter: ['all', ['==', ['get', 'type'], 'mapArea'], notSecret], layout: { 'fill-sort-key': ['get', 'zIndex'] }, paint: { 'fill-color': areaColor } },
      { id: 'prefabs', type: 'fill', source: 'game', 'source-layer': 'areas', filter: ['all', ['==', ['get', 'type'], 'prefab'], notSecret], layout: { 'fill-sort-key': ['get', 'zIndex'] }, paint: { 'fill-color': areaColor } },
      { id: 'roads-case', type: 'line', source: 'game', 'source-layer': 'roads', filter: ['all', ['==', ['get', 'type'], 'road'], notSecret], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': roadColor(1), 'line-gap-width': roadWidth, 'line-width': caseWidth } },
      { id: 'roads', type: 'line', source: 'game', 'source-layer': 'roads', filter: ['all', ['==', ['get', 'type'], 'road'], notSecret], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': roadColor(0), 'line-width': roadWidth } },
      { id: 'ferries', type: 'line', source: 'game', 'source-layer': 'roads', filter: ['==', ['get', 'type'], 'ferry'], paint: { 'line-color': '#6c90ff88', 'line-width': 1, 'line-dasharray': [4, 2] } },
      { id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0b3d91', 'line-width': routeCaseWidth, 'line-opacity': 0.9 } },
      { id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#3b9cff', 'line-width': routeWidth, 'line-opacity': 0.9 } },
      // Icons appear from zoom 6 and are drawn large so they can be found zoomed out (then zoom in).
      // Companies win over fuel/parking, which win over road shields, when icons would overlap.
      { id: 'road-shields', type: 'symbol', source: 'game', 'source-layer': 'pois', minzoom: 5, filter: ['==', ['get', 'poiType'], 'road'], layout: { 'icon-image': ['get', 'sprite'], 'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.4, 10, 0.6], 'icon-padding': 1 } },
      // Fuel, service/mechanics, rest areas etc. are the biggest icons; companies next.
      { id: 'company-icons', type: 'symbol', source: 'game', 'source-layer': 'pois', minzoom: 5, filter: ['==', ['get', 'poiType'], 'company'], layout: { 'icon-image': ['get', 'sprite'], 'icon-size': iconSize('company'), 'icon-padding': 0, 'icon-allow-overlap': ['step', ['zoom'], false, 10, true] } },
      { id: 'facility-icons', type: 'symbol', source: 'game', 'source-layer': 'pois', minzoom: 4, filter: ['==', ['get', 'poiType'], 'facility'], layout: { 'icon-image': ['get', 'sprite'], 'icon-size': iconSize('facility'), 'icon-padding': 0, 'icon-allow-overlap': ['step', ['zoom'], false, 9, true] } },
    ],
  };
}

const map = new maplibregl.Map({
  container: 'map',
  style: mapStyle(true),
  center: [-119.0, 35.4],
  zoom: 6,
  minZoom: 3,
  maxZoom: 18,
  attributionControl: false,
  dragRotate: true,
  maxPitch: 60,
});
// two-finger twist doesn't rotate (it used to stop following mid-pinch); the map is heading-up anyway
map.touchZoomRotate.disableRotation();
map.touchPitch.disable();
map.on('style.load', applyIconSizes);

// Truck marker: an arrow that rotates with the heading.
const truckEl = document.createElement('div');
truckEl.innerHTML = '<svg class="truckMarker" viewBox="0 0 44 44"><circle cx="22" cy="22" r="20" fill="#3b9cff33"/><path d="M22 6 L34 36 L22 29 L10 36 Z" fill="#3b9cff" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/></svg>';
const truckMarker = new maplibregl.Marker({ element: truckEl, rotationAlignment: 'map', pitchAlignment: 'map' });
let truckOnMap = false;

// City labels as lightweight HTML markers (no font server needed, works offline).
let cityMarkers = [];
function loadCityLabels() {
  fetch('/api/cities').then(r => r.json()).then(list => {
    for (const c of cityMarkers) c.marker.remove();
    cityMarkers = list.map(c => {
      const el = document.createElement('div');
      el.textContent = c.name;
      el.className = 'cityLabel' + (c.rank <= 3 ? ' major' : '');
      return { rank: c.rank, marker: new maplibregl.Marker({ element: el }).setLngLat(c.lngLat) };
    });
    updateCityLabels();
  }).catch(() => {});
}
loadCityLabels();
// The server rebuilt the map for a different set of owned states: fetch tiles and city names again.
function reloadMapData() {
  const center = map.getCenter(), zoom = map.getZoom(), bearing = map.getBearing(), pitch = map.getPitch();
  map.setStyle(mapStyle(currentNight !== false));
  map.once('style.load', () => map.jumpTo({ center, zoom, bearing, pitch }));
  loadCityLabels();
  toast('Map updated for your states');
}
function updateCityLabels() {
  const z = map.getZoom();
  for (const c of cityMarkers) {
    const show = z >= 9 || (z >= 7 && c.rank <= 6) || (z >= 5 && c.rank <= 3);
    if (show && !c.on) { c.marker.addTo(map); c.on = true; } else if (!show && c.on) { c.marker.remove(); c.on = false; }
  }
}
map.on('zoomend', updateCityLabels);

// Browsing the map (dragging away from the car) switches to north-up so the layout is familiar.
const stopFollow = () => {
  if (!follow) return;
  follow = false;
  $('btnRecenter').classList.remove('on');
  if (map.getBearing() !== 0) map.easeTo({ bearing: 0, pitch: 0, duration: 400 });
};
map.on('dragstart', stopFollow);
map.on('rotatestart', e => { if (e.originalEvent) stopFollow(); });
// Driver pinches the map during a junction → leave the zoom alone until the next maneuver.
map.on('zoomstart', e => { if (e.originalEvent && (jx.active || jx.target != null)) { jx.manual = jx.step; jx.active = false; jx.target = null; } });
$('btnRecenter').innerHTML = icon('locate');
$('btnFold').innerHTML = '<svg class="i" viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg>';
$('mapButtons').classList.toggle('folded', store.get('mapButtonsFolded', false));
$('btnFold').onclick = () => { const f = !$('mapButtons').classList.contains('folded'); $('mapButtons').classList.toggle('folded', f); store.set('mapButtonsFolded', f); };
// Hide / show the panel (instruments + cards): map and buttons only. Remembered on this device.
$('btnPanel').innerHTML = '<svg class="i" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>';
document.body.classList.toggle('panelHidden', store.get('panelHidden', false));
$('btnPanel').onclick = () => {
  const hide = !document.body.classList.contains('panelHidden');
  document.body.classList.toggle('panelHidden', hide);
  store.set('panelHidden', hide);
  setTimeout(() => map.resize(), 0);
};
$('btnSearch').innerHTML = icon('search');
$('btnEdit').innerHTML = icon('widgets');
$('btnSettings').innerHTML = icon('sliders');
$('btnRecenter').classList.add('on');
$('btnRecenter').onclick = () => { follow = true; $('btnRecenter').classList.add('on'); if (last) followTruck(true); };
$('btnOrient').onclick = () => { headingUp = !headingUp; store.set('headingUp', headingUp); $('btnOrient').textContent = headingUp ? 'N' : '↑'; if (!headingUp) map.easeTo({ bearing: 0 }); };
$('btnOrient').textContent = headingUp ? 'N' : '↑';
$('btnSearch').onclick = () => toggleSearch();
$('btnTheme').onclick = () => cycleTheme();
$('btnEdit').onclick = () => setEditing(!editing);
$('btnSettings').onclick = () => openSheet('settingsSheet');
$('editDone').onclick = () => setEditing(false);
$('editAdd').onclick = () => { refreshDrawer(); $('drawer').hidden = !$('drawer').hidden; };
$('editReset').onclick = () => {
  if (!confirm('Reset this screen layout to the default?')) return;
  settings.layouts = { ...(settings.layouts || {}) };
  delete settings.layouts[layoutKey()];
  const L = defaultLayout();
  for (const z of ZONES) { const zone = $('zone-' + z); zone.innerHTML = ''; for (const id of L[z]) zone.appendChild(createWidget(id, z)); }
  if (last) updateWidgets(last);
  refreshDrawer();
};
document.querySelectorAll('[data-close]').forEach(b => (b.onclick = () => ($(b.dataset.close).hidden = true)));

function toggleSearch(show) {
  const box = $('searchBox');
  box.hidden = show == null ? !box.hidden : !show;
  if (!box.hidden) $('searchInput').focus(); else { $('searchResults').hidden = true; $('searchInput').blur(); }
}
function toggleFullscreen() { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); }
function openSheet(id) {
  closeSheets();
  if (id === 'settingsSheet') renderSettings();
  $(id).hidden = false;
}
function closeSheets() { for (const id of ['jobSheet', 'favSheet', 'camSheet', 'settingsSheet', 'pointMenu', 'stopMenu']) $(id).hidden = true; }

// Day / night: Auto follows the in-game clock; the map button cycles Auto → Day → Night.
const THEMES = ['auto', 'day', 'night'];
const themeIcon = () => ({ auto: 'auto', day: 'sun', night: 'moon' })[settings?.theme || 'auto'];
function cycleTheme() {
  if (!settings) return;
  const next = THEMES[(THEMES.indexOf(settings.theme || 'auto') + 1) % THEMES.length];
  saveSettings({ theme: next });
  toast({ auto: 'Theme: automatic (game time)', day: 'Theme: day', night: 'Theme: night' }[next]);
}
function updateThemeButton() { $('btnTheme').innerHTML = icon(themeIcon()); }
updateThemeButton();

function bearingOf(ch) {
  const p = ch['truck.world.placement'];
  return p ? ((1 - p.rot[0]) * 360) % 360 : 0;   // SDK heading: 0..1, counter-clockwise from north
}
// ---- smooth follow camera
// Positions arrive ~10× per second. Moving the map only then looked like "tick tick tick" at highway
// speed, so the car's motion is predicted from its last positions and the car + map are moved on
// every screen frame instead. Zoom follows speed continuously: far out on the highway, closer in town,
// and zoomed in only for an upcoming junction (see updateJunction). Pinching while following keeps
// your zoom as an offset to the automatic one until you press "follow" again.
const cam = {
  fix: null, prev: null, vel: [0, 0],        // last position fix, the one before, velocity (deg/s)
  pos: null, bearing: 0, zoom: null, pitch: 0, // what is drawn
  speed: 0, baseZoom: 15, userOffset: 0, gesture: false, snap: true, lastFrame: 0,
};
// zoom by speed (m/s) while navigating; a bit further out without a route
const SPEED_ZOOM = [[0, 15.0], [6, 14.5], [12, 13.4], [18, 12.4], [24, 11.7], [30, 11.1], [40, 10.5]];
function speedZoom(v) {
  let z = SPEED_ZOOM[SPEED_ZOOM.length - 1][1];
  for (let i = 0; i < SPEED_ZOOM.length - 1; i++) {
    const [v0, z0] = SPEED_ZOOM[i], [v1, z1] = SPEED_ZOOM[i + 1];
    if (v <= v1) { z = z0 + ((Math.max(v, v0) - v0) / (v1 - v0)) * (z1 - z0); break; }
  }
  return route ? z : z - 0.6;
}
const angleDiff = (a, b) => ((b - a + 540) % 360) - 180;
// new position from the game
// Fixes come from the fast position stream ('pos', up to ~60/s), or from the 10/s dashboard state
// when the stream isn't there (older plugin). Velocity is measured over the last ~0.12 s of fixes:
// consecutive fixes at 60/s are too close in time to give a steady direction and speed.
let lastPosStream = 0;
const camHist = [];
function camFix(pos, bearing, speed) {
  if (!pos) return;
  const now = performance.now();
  const fix = { pos, t: now, bearing };
  const prev = cam.fix;
  if (prev && geoMetres(prev.pos, pos) >= 400) { camHist.length = 0; cam.vel = [0, 0]; cam.snap = true; }   // ferry / teleport
  camHist.push(fix);
  while (camHist.length > 2 && now - camHist[1].t > 120) camHist.shift();
  const old = camHist[0], dt = (now - old.t) / 1000;
  if (dt > 0.04 && dt < 1.5) {
    const v = [(pos[0] - old.pos[0]) / dt, (pos[1] - old.pos[1]) / dt];
    cam.vel = [cam.vel[0] * 0.5 + v[0] * 0.5, cam.vel[1] * 0.5 + v[1] * 0.5];
  } else if (dt >= 1.5) cam.vel = [0, 0];
  cam.prev = prev;
  cam.fix = fix;
  cam.speed = cam.speed * 0.85 + speed * 0.15;
  if (!truckOnMap) { truckMarker.setLngLat(fix.pos).addTo(map); truckOnMap = true; cam.snap = true; }
}
function camFrame(now) {
  requestAnimationFrame(camFrame);
  if (!cam.fix) return;
  const dt = Math.min(0.1, Math.max(0, (now - (cam.lastFrame || now)) / 1000));
  cam.lastFrame = now;
  // predicted position: last fix moved on by the measured velocity (at most 0.35 s ahead)
  const ahead = Math.min(0.35, (now - cam.fix.t) / 1000);
  const target = [cam.fix.pos[0] + cam.vel[0] * ahead, cam.fix.pos[1] + cam.vel[1] * ahead];
  const k = cam.snap ? 1 : 1 - Math.exp(-dt * 14);
  cam.pos = cam.pos && !cam.snap ? [cam.pos[0] + (target[0] - cam.pos[0]) * k, cam.pos[1] + (target[1] - cam.pos[1]) * k] : target;
  cam.bearing = cam.snap ? cam.fix.bearing : (cam.bearing + angleDiff(cam.bearing, cam.fix.bearing) * (1 - Math.exp(-dt * 8)) + 360) % 360;
  truckMarker.setLngLat(cam.pos).setRotation(cam.bearing);
  if (!follow || cam.gesture) { cam.snap = false; return; }

  const navigating = !!route;
  cam.baseZoom = speedZoom(cam.speed) + cam.userOffset;
  const zTarget = navigating && jx.active && jx.target != null ? jx.target : cam.baseZoom;
  if (cam.zoom == null || cam.snap) cam.zoom = zTarget;
  else {
    const rate = 1.1 * dt;   // zoom levels per second: gentle in and out
    cam.zoom += Math.max(-rate, Math.min(rate, (zTarget - cam.zoom) * (1 - Math.exp(-dt * 2.5))));
  }
  // tilt more at speed: a steeper view shows much more road ahead (up to the 60° limit)
  const pitchTarget = navigating ? (jx.active ? 40 : 48 + Math.min(1, cam.speed / 30) * 12) : 0;
  cam.pitch += (pitchTarget - cam.pitch) * (cam.snap ? 1 : 1 - Math.exp(-dt * 3));
  const h = map.getContainer().clientHeight;
  map.jumpTo({
    center: cam.pos,
    zoom: cam.zoom,
    // heading-up only up close; zoomed out the map is north-up like the in-game map
    // following: the map turns with the car so its arrow always points up (any zoom; at highway
    // speed the zoom drops below 11 and the map used to switch to north-up there)
    bearing: headingUp ? cam.bearing : 0,
    pitch: cam.pitch,
    padding: { top: navigating ? Math.round(h * 0.44) : 0, bottom: 0, left: 0, right: 0 },
  });
  cam.snap = false;
}
requestAnimationFrame(camFrame);
// (re)start following: jump straight to the car at the automatic zoom
function followTruck(force) {
  if (force) { cam.snap = true; cam.userOffset = 0; }
}
// Pinch / wheel while following: the camera stops writing to the map while fingers are down (moving
// it every frame used to cancel the pinch), then keeps following with your zoom as an offset to the
// automatic zoom until you press "follow" again.
let gestureTimer = 0;
function gestureEnd() {
  if (!cam.gesture) return;
  cam.gesture = false;
  if (follow && !jx.active) cam.userOffset = Math.max(-4, Math.min(4, map.getZoom() - speedZoom(cam.speed)));
  cam.zoom = map.getZoom();
}
const mapEl = map.getCanvasContainer();
mapEl.addEventListener('touchstart', e => { if (e.touches.length >= 2) cam.gesture = true; }, { passive: true });
mapEl.addEventListener('touchend', e => { if (e.touches.length === 0) { clearTimeout(gestureTimer); gestureTimer = setTimeout(gestureEnd, 150); } }, { passive: true });
mapEl.addEventListener('wheel', () => { cam.gesture = true; clearTimeout(gestureTimer); gestureTimer = setTimeout(gestureEnd, 400); }, { passive: true });

// Tap on the map → navigate / favourite.
let picked = null;
// Long press (~0.5 s, finger or mouse) or right-click opens the destination menu, so a normal tap
// or pan never opens it by accident. Moving more than a few pixels cancels the long press.
const LONG_PRESS_MS = 500, LONG_PRESS_MOVE_PX = 10;
let pressTimer = 0, pressStart = null, menuOpenedAt = 0;
function startLongPress(e) {
  if (e.originalEvent.touches && e.originalEvent.touches.length > 1) return cancelLongPress();   // pinch
  pressStart = e.point;
  const lngLat = [e.lngLat.lng, e.lngLat.lat];
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => { pressStart = null; menuOpenedAt = Date.now(); navigator.vibrate?.(30); openPointMenu(lngLat, 'Selected point'); }, LONG_PRESS_MS);
}
function moveLongPress(e) {
  if (pressStart && Math.hypot(e.point.x - pressStart.x, e.point.y - pressStart.y) > LONG_PRESS_MOVE_PX) cancelLongPress();
}
function cancelLongPress() { clearTimeout(pressTimer); pressStart = null; }
map.on('touchstart', startLongPress);
map.on('mousedown', e => { if (e.originalEvent.button === 0) startLongPress(e); });
map.on('touchmove', moveLongPress);
map.on('mousemove', moveLongPress);
for (const ev of ['touchend', 'touchcancel', 'mouseup', 'dragstart', 'zoomstart', 'rotatestart']) map.on(ev, cancelLongPress);
map.on('contextmenu', e => { e.preventDefault?.(); cancelLongPress(); menuOpenedAt = Date.now(); openPointMenu([e.lngLat.lng, e.lngLat.lat], 'Selected point'); });
// A plain tap closes the menu, but not the click that comes from releasing the long press itself.
map.on('click', () => { if (!$('pointMenu').hidden && Date.now() - menuOpenedAt > 600) $('pointMenu').hidden = true; });
// With a route already running, a picked point becomes one more stop (the default) or replaces the
// route; without one it simply becomes the destination.
function openPointMenu(lngLat, name, kind) {
  picked = { lngLat, name, kind };
  $('pointTitle').textContent = name;
  $('pmNavigate').textContent = route ? '＋ Add as stop' : 'Navigate here';
  $('pmReplace').hidden = !route;
  $('pointMenu').hidden = false;
  $('suggestion').hidden = true;
  $('stopMenu').hidden = true;
}
$('pmCancel').onclick = () => { $('pointMenu').hidden = true; };
async function routeToPicked(mode) {
  $('pointMenu').hidden = true;
  if (!picked) return;
  toast(mode === 'replace' ? 'Calculating new route…' : route ? 'Adding stop…' : 'Calculating route…');
  const r = await api('POST', '/api/route', { lngLat: picked.lngLat, name: picked.name === 'Selected point' ? 'Map point' : picked.name, kind: picked.kind, mode });
  if (r?.error) toast(r.error);
}
$('pmNavigate').onclick = () => routeToPicked('add');
$('pmReplace').onclick = () => routeToPicked('replace');

// Route stops on the map: numbered pins in driving order, the final destination as a flag (a box for
// the job). Hold a pin (~0.5 s) to remove that stop; a tap just names it.
let stopMarkers = [];
function renderStopMarkers(r) {
  for (const m of stopMarkers) m.remove();
  stopMarkers = [];
  for (const s of r?.stops || []) {
    const el = document.createElement('div');
    el.className = `stopPin k-${s.kind}${s.final ? ' final' : ''}`;
    el.innerHTML = `<div class="pinBody"><span>${s.final ? icon(s.kind === 'job' ? 'box' : 'flag') : s.n}</span></div>`;
    onHold(el, () => openStopMenu(s), () => toast(s.final ? `Destination: ${s.name}` : `Stop ${s.n}: ${s.name}, hold to remove`));
    stopMarkers.push(new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(s.lngLat).addTo(map));
  }
}
// Long-press on an element over the map without the map seeing the touch (no pan, no map menu).
function onHold(el, hold, tap) {
  let timer = 0, start = null, fired = false;
  el.addEventListener('pointerdown', e => {
    e.stopPropagation(); fired = false; start = [e.clientX, e.clientY];
    clearTimeout(timer);
    timer = setTimeout(() => { fired = true; start = null; navigator.vibrate?.(30); hold(); }, LONG_PRESS_MS);
  });
  el.addEventListener('pointermove', e => { if (start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > LONG_PRESS_MOVE_PX) { clearTimeout(timer); start = null; } });
  el.addEventListener('pointerup', e => { e.stopPropagation(); clearTimeout(timer); if (start && !fired) tap?.(); start = null; });
  el.addEventListener('pointercancel', () => { clearTimeout(timer); start = null; });
  for (const ev of ['mousedown', 'touchstart', 'click', 'dblclick']) el.addEventListener(ev, e => e.stopPropagation());
  el.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); clearTimeout(timer); hold(); });
}
let stopPicked = null;
function openStopMenu(s) {
  stopPicked = s;
  $('pointMenu').hidden = true;
  $('stopTitle').textContent = s.final ? (s.kind === 'job' ? `Job: ${s.name}` : `Destination: ${s.name}`) : `Stop ${s.n}: ${s.name}`;
  $('smRemove').textContent = s.kind === 'job' ? 'Stop guiding to the job' : s.final ? 'Remove destination' : `Remove stop ${s.n}`;
  $('stopMenu').hidden = false;
}
$('smCancel').onclick = () => { $('stopMenu').hidden = true; };
$('smRemove').onclick = async () => {
  $('stopMenu').hidden = true;
  if (!stopPicked) return;
  const r = await api('DELETE', '/api/route/stop/' + encodeURIComponent(stopPicked.id));
  if (r?.error) toast(r.error); else toast(stopPicked.kind === 'job' ? 'Job route off' : 'Removed, route recalculated');
};
$('pmFavourite').onclick = async () => {
  $('pointMenu').hidden = true;
  if (!picked) return;
  const name = prompt('Name for this favourite', picked.name === 'Selected point' ? '' : picked.name);
  if (!name) return;
  renderFavourites(await api('POST', '/api/favourites', { name, lngLat: picked.lngLat }));
  toast('Saved to favourites');
};

// ------------------------------------------------------------------ search

let searchTimer = 0;
$('searchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $('searchInput').value;
    const box = $('searchResults');
    if (q.trim().length < 2) { box.hidden = true; return; }
    const list = await api('GET', '/api/search?q=' + encodeURIComponent(q));
    box.innerHTML = '';
    for (const r of list || []) {
      const div = document.createElement('div');
      div.innerHTML = `${{ city: '🏙', company: '🏭', favourite: '★' }[r.kind] || '•'} ${esc(r.name)}<small>${esc(r.detail || '')}</small>`;
      div.onclick = () => { box.hidden = true; $('searchInput').value = ''; toggleSearch(false); stopFollow(); map.flyTo({ center: r.lngLat, zoom: 13 }); openPointMenu(r.lngLat, `${r.name}${r.detail ? ', ' + r.detail : ''}`); };
      box.appendChild(div);
    }
    box.hidden = !box.children.length;
  }, 250);
});
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ------------------------------------------------------------------ route display

// The route line lives in the map style, so it must be re-applied whenever the style is (re)loaded,
// e.g. after the day/night theme switch.
function applyRouteLine() {
  const src = map.getSource('route');
  if (src) src.setData(route ? { type: 'Feature', geometry: { type: 'LineString', coordinates: smoothRouteLine(route.line) } } : { type: 'FeatureCollection', features: [] });
}
// Drawn route only (navigation keeps the exact line): the game's lane paths jog sideways by a lane
// wherever a road piece changes its lane layout, which showed as zigzags on straight roads. Points that
// stray less than ~a lane from a straight line are dropped (Douglas–Peucker), then corners are rounded.
const ROUTE_SMOOTH_M = 90;   // map metres ≈ one 4.5 m game lane
function smoothRouteLine(line) {
  if (!line || line.length < 3) return line;
  const lat0 = line[0][1] * Math.PI / 180, kx = Math.cos(lat0) * 111320, ky = 110540;
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = line[a][0] * kx, ay = line[a][1] * ky, bx = line[b][0] * kx, by = line[b][1] * ky;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    let far = -1, fd = ROUTE_SMOOTH_M;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((line[i][0] * kx - ax) * dy - (line[i][1] * ky - ay) * dx) / len;
      if (d > fd) { fd = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  let pts = line.filter((_, i) => keep[i]);
  // Chaikin corner rounding, twice
  for (let it = 0; it < 2 && pts.length > 2; it++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      out.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25], [p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}
map.on('style.load', applyRouteLine);

function showRoute(r) {
  route = r;
  document.body.classList.toggle('navigating', !!r);
  applyRouteLine();
  renderStopMarkers(r);
  if (!r) $('navBanner').hidden = true;
  if (last) updateWidgets(last);
  if (follow) followTruck(true);
}

// ------------------------------------------------------------------ live state rendering


function render(s) {
  last = s;
  const ch = s.ch || {};
  $('connBadge').classList.toggle('ok', !!s.connected && !!s.lngLat);
  $('connBadge').textContent = !s.connected ? 'Game not running (waiting for the ATS Co-Driver plugin)' : s.paused ? 'Game paused' : 'Waiting for position…';
  if (s.connected && s.paused) $('connBadge').classList.remove('ok');

  const g = ch['truck.displayed.gear'];
  syncWipers(ch['truck.wipers']);
  updateWidgets(s);

  // speeding alert (the speedometer / limit sign widgets show it visually)
  if (isSpeeding(ch) && Date.now() - lastSpeedAlert > 15000) { lastSpeedAlert = Date.now(); navigator.vibrate?.([120, 80, 120]); }

  // junction view runs before the map follows the car, so the zoom target is current
  if (route && s.nav) updateJunction(s);
  else { jx.active = false; jx.target = null; $('laneStrip').hidden = true; $('navThen').hidden = true; }

  // truck on map: the smooth camera (camFrame) moves car + map every frame from this fix
  if (performance.now() - lastPosStream > 1000) camFix(s.lngLat, bearingOf(ch), Math.abs(ch['truck.speed'] ?? 0));

  // navigation banner + trip bar
  if (route && s.nav) {
    const n = s.nav.next || {};
    $('navBanner').hidden = false;
    $('navBanner').classList.toggle('off', !!s.nav.offRoute);
    $('navArrow').textContent = s.nav.offRoute ? '⟲' : dirArrow(Number(n.direction));
    $('navDist').textContent = s.nav.offRoute ? 'Recalculating…' : fmtDist(s.nav.toNext);
    $('navWhat').textContent = s.nav.offRoute ? 'You left the route' : [dirText(Number(n.direction), n.exit), n.banner].filter(Boolean).join(' · ');
  }

  renderJob(s.job, s.timing);
  renderPlace(s.here);
  autoTheme(ch);
  autoReverseCamera(g);
}

// ---- "press Enter" helper: stopped at a company, garage, pump or rest area → one big button that
// sends the game's Enter (activate). Pumps and plain rest areas need the engine off first, so until
// then the button switches the engine off instead. ✕ hides it until you drive away.
let placeHidden = null, placeSentAt = 0;
const PLACE_ICON = { company: 'box', service: 'wrench', fuel: 'fuel', rest: 'bed' };
function renderPlace(h) {
  const box = $('actionPrompt');
  if (!h) { placeHidden = null; box.hidden = true; return; }
  if (placeHidden === h.name || editing) { box.hidden = true; return; }
  const wasHidden = box.hidden;
  box.hidden = false;
  box.dataset.kind = h.kind;
  const needOff = h.needEngineOff && h.engineOn;
  box.classList.toggle('engine', needOff);
  box.classList.toggle('sent', Date.now() - placeSentAt < 2500);
  if (box.dataset.icon !== h.kind) { box.dataset.icon = h.kind; $('apIcon').innerHTML = icon(PLACE_ICON[h.kind] || 'dot'); }
  const fuelHere = h.kind === 'fuel' && !needOff;
  $('apTitle').textContent = needOff ? 'Engine off first' : fuelHere ? (refuelActive ? 'Filling up…' : 'Refuel') : h.action;
  $('apSub').textContent = needOff ? `to ${h.kind === 'fuel' ? 'refuel' : 'sleep'} · ${h.name}` : h.name;
  $('apGo').textContent = needOff ? '⏻ Engine off' : fuelHere ? (refuelActive ? '■ Stop' : '⛽ Fill up') : '⏎ Enter';
  // at a rest area: how long you can rest and still deliver on time
  const info = h.kind === 'rest' ? restAllowance(last?.timing) : '';
  $('apInfo').hidden = !info;
  $('apInfo').textContent = info;
  if (wasHidden) navigator.vibrate?.(40);
}
// How long you can rest now and still deliver on time, keeping a safety margin for traffic and
// trouble on the road (10 % of the remaining drive, at least 30 game minutes).
function restAllowance(t) {
  if (!t) return 'No delivery running, rest as long as you like';
  if (t.eta == null || t.spare == null) return 'Set the route to the delivery to see how long you can rest';
  const margin = Math.max(30, Math.round(t.eta * 0.1));
  const max = t.spare - margin;
  if (max <= 5) return `No time to rest, you'd be late (${fmtDurShort(Math.max(0, t.spare) * 60)} spare)`;
  const full = settings?.rest?.durationMin ?? 600;
  return `You can rest up to ${fmtDurShort(max * 60)} (keeps ${fmtDurShort(margin * 60)} spare)${max >= full ? ' · a full sleep fits ✓' : ' · a full sleep makes you late'}`;
}
let refuelActive = false;
const sendAction = (action, want) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ action, want })); navigator.vibrate?.(20); };
$('apGo').onclick = () => {
  const h = last?.here;
  if (!h) return;
  if (h.needEngineOff && h.engineOn) { sendAction('engine', 'off'); return; }
  // at a pump: one tap fills the tank (Enter is held until full); tap again to stop
  if (h.kind === 'fuel') { sendAction('refuel'); return; }
  press('activate');
  placeSentAt = Date.now();
  $('actionPrompt').classList.add('sent');
};
$('apClose').onclick = () => { placeHidden = last?.here?.name ?? null; $('actionPrompt').hidden = true; };

// Game time is absolute minutes since Monday 00:00 of the first in-game week.
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function fmtClock(m) {
  if (typeof m !== 'number') return '–';
  const d = DAYS[Math.floor(m / 1440) % 7], hh = Math.floor((m % 1440) / 60), mm = Math.floor(m % 60);
  return `${d} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
// Local time: the game clock is Pacific-based; the in-game clock and the job screen show local time.
// Delivery times are shown in the destination's zone, the clock in the zone where the car is ("MT").
const destShift = t => t?.tz?.dest?.shift ?? 0;
const destTime = (t, m, withDay = false) => (typeof m !== 'number' ? '–' : (withDay ? fmtClock(m + destShift(t)) : fmtClock(m + destShift(t)).slice(4)) + (t?.tz?.dest?.abbr ? ' ' + t.tz.dest.abbr : ''));
const hereTime = (s, m) => (typeof m !== 'number' ? '–' : fmtClock(m + (s?.clockTz?.shift ?? 0)));
function fmtSpare(min) {
  if (min == null) return { text: '–', cls: '' };
  return min >= 0 ? { text: '+' + fmtDurShort(min * 60), cls: 'good' } : { text: '−' + fmtDurShort(-min * 60), cls: 'bad' };
}

// "Arrive not before" (delivery window start) isn't sent by the game, so it's entered here once per job.
let lastTiming = null;
$('btnSetEarliest').onclick = async () => {
  const t = lastTiming;
  if (!t) return toast('No active job');
  const cur = t.earliest != null ? fmtClock(t.earliest + destShift(t)).slice(4) : '';
  const v = prompt(`Arrive not before (HH:MM as shown in the game's job window${t.tz?.dest?.abbr ? `, ${t.tz.dest.abbr}` : ''}, e.g. 16:06). Leave empty to use the 5-hour guess.`, cur);
  if (v === null) return;
  let earliest = null;
  const mt = v.trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (v.trim() && !mt) return toast('Use HH:MM, e.g. 16:06');
  if (mt) {
    // typed in destination local time → game clock. Same day as the deadline; if that would be after
    // the deadline, it's the day before.
    const dueLocal = t.due + destShift(t);
    let local = Math.floor(dueLocal / 1440) * 1440 + Number(mt[1]) * 60 + Number(mt[2]);
    if (local > dueLocal) local -= 1440;
    earliest = local - destShift(t);
  }
  const r = await api('PUT', '/api/job/earliest', { earliest });
  if (r?.error) toast(r.error); else toast(earliest == null ? 'Window start cleared' : 'Window start saved');
};

function renderJob(j, t) {
  lastTiming = t;
  $('jobEmpty').hidden = !!j;
  $('jobCard').hidden = !j;
  if (!j) return;
  $('jobEarliest').textContent = t?.earliest != null ? destTime(t, t.earliest, true) + (t.earliestGuessed ? ' (guess: 5 h window)' : '') : 'not set';
  $('jobCargo').textContent = j.cargo || 'Delivery';
  $('jobFrom').textContent = j.from;
  $('jobTo').textContent = j.to;
  $('jobIncome').textContent = money(j.income);
  $('jobPlanned').textContent = j.plannedKm ? fmtDist(j.plannedKm * 1000) : '–';
  $('jobDue').textContent = t ? destTime(t, t.due, true) : '–';
  $('jobLeft').textContent = t ? (t.dueIn >= 0 ? fmtDur(t.dueIn * 60) : 'Overdue') : '–';
  $('jobLeft').className = t && t.dueIn < 0 ? 'bad' : '';
  $('jobEta').textContent = t?.eta != null
    ? `${destTime(t, t.now + t.eta, true)} (in ${fmtDur(t.eta * 60)})${t.etaSource === 'game' ? ' · game GPS' : ''}`
    : 'Set the route to see it';
  // Too early beats spare time: arriving before the window opens is the problem to show.
  if (t?.early != null) {
    $('jobSpareLabel').textContent = 'Too early by';
    $('jobSpare').textContent = fmtDurShort(t.early * 60);
    $('jobSpare').className = 'bad';
  } else {
    const sp = fmtSpare(t?.spare);
    $('jobSpareLabel').textContent = t?.spare != null && t.spare < 0 ? 'Late by' : 'Spare time';
    $('jobSpare').textContent = sp.text;
    $('jobSpare').className = sp.cls;
  }
}

// Night theme follows in-game time when theme = auto.
let currentNight = true;
function autoTheme(ch) {
  let night = true;
  if (settings?.theme === 'day') night = false;
  else if (settings?.theme === 'auto' && ch['game.time'] != null) { const m = ch['game.time'] % 1440; night = m < 6 * 60 || m >= 20 * 60; }
  if (night === currentNight) return;
  currentNight = night;
  document.body.dataset.theme = night ? 'night' : 'day';
  document.querySelector('meta[name="theme-color"]').content = night ? '#06080b' : '#dfe4ea';
  const center = map.getCenter(), zoom = map.getZoom(), bearing = map.getBearing(), pitch = map.getPitch();
  map.setStyle(mapStyle(night));
  map.once('style.load', () => map.jumpTo({ center, zoom, bearing, pitch }));
}

// Reverse gear → show the rear camera sheet (and close it again when leaving reverse).
function autoReverseCamera(gear) {
  if (!settings?.camera.enabled || !settings.camera.autoOnReverse || editing) return;
  const reversing = gear != null && gear < 0;
  if (reversing && !reverseCamAuto) { reverseCamAuto = true; openSheet('camSheet'); }
  else if (!reversing && reverseCamAuto) { reverseCamAuto = false; $('camSheet').hidden = true; }
}

// ------------------------------------------------------------------ controls

// hold: how long the game input stays pressed (ms). Taps toggle things; windows only move while held.
function press(mix, hold) { if (ws?.readyState === 1) ws.send(JSON.stringify(hold ? { press: mix, hold } : { press: mix })); navigator.vibrate?.(20); }

// Buttons whose game action isn't a simple toggle get their own behaviour:
// - wipers: the game's "wipers" key only steps the speed up (and stops at the fastest); "wipersback"
//   steps down. The direct wipers0..4 actions don't switch them off (verified in the plugin log),
//   so the button steps up and, from the fastest speed, steps down 4x to reach off.
// - windows: open/close are separate actions that move the glass only while held
let wiperLevel = 0;
// Windows move only while the key is held. Down took ~2.5 s, but up is slower and stopped half way,
// so closing holds the key for ~9 s (two overlapping holds; the plugin allows 6 s per hold).
const WIN_OPEN_MS = 4000, WIN_CLOSE_MS = 9000;
function holdFor(mix, ms) {
  press(mix, Math.min(ms, 6000));
  for (let at = 5500; at < ms; at += 5500) setTimeout(() => press(mix, Math.min(6000, ms - at + 200)), at);
}
const winOpen = { l: store.get('winL', false), r: store.get('winR', false) };
// The game doesn't report the radio, so its on/off state is kept here (tap = toggle).
let radioOn = store.get('radioOn', false);
const WIPER_NAMES = ['off', 'slow', 'medium', 'fast'];
const SPECIAL_CONTROLS = {
  // engine: smart two-stage start/stop on the server (electrics → starter; off checks it really stopped)
  engine: {
    label: () => (last?.ch?.['truck.engine.enabled'] ? 'Engine on' : last?.ch?.['truck.electric.enabled'] ? 'Electrics on' : 'Engine off'),
    run() { sendAction('engine'); },
  },
  radiotoggle: {
    label: () => (radioOn ? 'Radio on' : 'Radio off'),
    run() { press('radiotoggle'); radioOn = !radioOn; store.set('radioOn', radioOn); },
  },
  wipers: {
    label: () => `Wipers ${WIPER_NAMES[wiperLevel]}`,
    run() {
      wiperPressedAt = Date.now();
      if (wiperLevel < 3) { wiperLevel++; press('wipers'); return; }
      wiperLevel = 0;
      for (let i = 0; i < 4; i++) setTimeout(() => press('wipersback'), i * 300);
      wiperPressedAt = Date.now() + 1200;   // the step-down sequence takes ~1 s
    },
  },
  lwinopen: {
    label: () => (winOpen.l ? 'Close L' : 'Open L'),
    run() { holdFor(winOpen.l ? 'lwinclose' : 'lwinopen', winOpen.l ? WIN_CLOSE_MS : WIN_OPEN_MS); winOpen.l = !winOpen.l; store.set('winL', winOpen.l); },
  },
  rwinopen: {
    label: () => (winOpen.r ? 'Close R' : 'Open R'),
    run() { holdFor(winOpen.r ? 'rwinclose' : 'rwinopen', winOpen.r ? WIN_CLOSE_MS : WIN_OPEN_MS); winOpen.r = !winOpen.r; store.set('winR', winOpen.r); },
  },
};

// Keep the wiper level honest: the game reports whether the wipers are running at all.
// Right after a tap the game still reports the old state for a moment, so ignore it for a while
// and only follow a state that has stayed the same for over a second (otherwise "off" bounced to "slow").
let wiperPressedAt = 0, wiperSeen = null, wiperSeenSince = 0;
function syncWipers(on) {
  if (on == null) return;
  if (on !== wiperSeen) { wiperSeen = on; wiperSeenSince = Date.now(); return; }
  if (Date.now() - wiperPressedAt < 3000 || Date.now() - wiperSeenSince < 1200) return;
  if (!on) wiperLevel = 0;
  else if (wiperLevel === 0) wiperLevel = 1;
}
document.querySelectorAll('[data-press]').forEach(b => (b.onclick = () => press(b.dataset.press)));

// ------------------------------------------------------------------ favourites

let favourites = [];
function favRow(f, withDelete) {
  const row = document.createElement('div');
  row.innerHTML = `<span>★ ${esc(f.name)}</span>`;
  const go = document.createElement('button'); go.textContent = 'Go'; go.className = 'primary';
  go.onclick = async e => {
    e.stopPropagation();
    if (editing) return;
    $('favSheet').hidden = true;
    // on a trip: ask "add as stop / replace"; otherwise go straight there
    if (route) return openPointMenu(f.lngLat, f.name, 'favourite');
    toast('Calculating route…');
    const r = await api('POST', '/api/route', { lngLat: f.lngLat, name: f.name, kind: 'favourite' });
    if (r?.error) toast(r.error);
  };
  row.append(go);
  if (withDelete) {
    const del = document.createElement('button'); del.textContent = '✕';
    del.onclick = async () => renderFavourites(await api('DELETE', '/api/favourites/' + f.id));
    row.append(del);
  }
  return row;
}
// favourites card widget: first few, Go only
function fillFavRows(box) {
  box.innerHTML = '';
  if (!favourites.length) { box.innerHTML = '<span class="muted small">Long-press the map → "Add to favourites"</span>'; return; }
  for (const f of favourites.slice(0, 5)) box.appendChild(favRow(f, false));
}
function renderFavourites(list) {
  favourites = list || [];
  const box = $('favList');
  document.querySelectorAll('.w[data-id="favs"] .favRows').forEach(fillFavRows);
  if (!favourites.length) { box.className = 'muted'; box.textContent = 'No favourites yet. Long-press anywhere on the map → "Add to favourites".'; return; }
  box.className = '';
  box.innerHTML = '';
  for (const f of favourites) box.appendChild(favRow(f, true));
}

// ------------------------------------------------------------------ suggestions

function showSuggestion(s) {
  $('suggestion').hidden = !s;
  if (!s) return;
  $('pointMenu').hidden = true;
  $('sugReason').textContent = ({ fuel: '⛽ ', rest: '🅿 ', service: '🔧 ' }[s.kind] || '') + s.reason;
  $('sugStop').textContent = s.stop.name;
  const extras = s.stop.facilities.map(f => ({ gas_ico: 'fuel', parking_ico: 'parking', service_ico: 'repair', garage_large_ico: 'garage' })[f]).filter(Boolean).join(' · ');
  // on a trip the stop is added to the route, so the useful number is the extra time it costs
  const detour = s.stop.detour != null && route ? (s.stop.detour < 90 ? 'on your way' : `+${fmtDur(s.stop.detour)} detour`) : null;
  $('sugInfo').textContent = [detour ?? `${fmtDist(s.stop.distance)} · ${fmtDur(s.stop.duration)}`, extras].filter(Boolean).join(' · ');
  $('sugGo').textContent = route ? '＋ Add to route' : 'Go there';
  const allowance = s.kind === 'rest' ? restAllowance(last?.timing) : '';
  const detail = [s.stop.detail, allowance].filter(Boolean).join(' · ');
  $('sugDetail').hidden = !detail;
  $('sugDetail').textContent = detail;
  navigator.vibrate?.([200, 100, 200]);
}
$('sugGo').onclick = () => { $('suggestion').hidden = true; api('POST', '/api/suggestion/accept'); };
$('sugLater').onclick = () => { $('suggestion').hidden = true; api('POST', '/api/suggestion/dismiss'); };

// ------------------------------------------------------------------ settings form

// Settings: a category list (left; tabs on top on phones) and one clear row per setting: what it
// does in plain words on the left, a big control on the right (switch, choice buttons, − value +).
// Rows that depend on a switch dim while it is off. Every change is saved at once ("✓ Saved").
let setTab = 'display';
function renderSettings() {
  const s = settings;
  if (!s) return;
  const row = (title, desc, control, dep) => `<div class="setRow${dep && !get(s, dep) ? ' off' : ''}"${dep ? ` data-dep="${dep}"` : ''}><div class="txt"><b>${title}</b>${desc ? `<span>${desc}</span>` : ''}</div>${control}</div>`;
  const sw = path => `<label class="sw"><input type="checkbox" data-path="${path}" ${get(s, path) ? 'checked' : ''}><span></span></label>`;
  const seg = (path, opts) => `<div class="seg" data-seg="${path}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${get(s, path) === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const step = (path, min, max, st, unit = '') => `<div class="step" data-step="${path}" data-min="${min}" data-max="${max}" data-st="${st}"><button type="button" data-d="-1">−</button><output>${get(s, path)}<small>${unit}</small></output><button type="button" data-d="1">+</button></div>`;
  const group = (title, rows) => `<div class="setGroup">${title ? `<div class="gTitle">${title}</div>` : ''}${rows.join('')}</div>`;
  const shownTt = s.telltales ?? TELLTALES.map(t => t.id);
  const TABS = {
    display: ['sun', 'Display', 'How Co-Driver looks on this screen.', [
      group('', [
        row('Day / night', 'Auto switches with the clock in the game', seg('theme', [['auto', 'Auto'], ['day', 'Day'], ['night', 'Night']])),
        row('Units', 'Speed and distances', seg('units', [['imperial', 'mph · miles'], ['metric', 'km/h · km']])),
        row('Keep the screen on', 'The tablet does not go to sleep while Co-Driver is open', sw('keepAwake')),
      ]),
      group('Layout', [
        row('Arrange the screen', 'Move, add or remove gauges, cards and switches', '<button type="button" id="setCustomize" class="primary">Customize</button>'),
        row('Full screen', 'Hide the browser bars', '<button type="button" id="setFull">Toggle</button>'),
      ]),
      group('Warning lights', [
        row('Hide lights that are off', 'Like a real dashboard: only lit lights show', sw('telltalesHideOff')),
        `<div class="ttPick">${TELLTALES.map(t => `<label><input type="checkbox" data-tt="${t.id}" ${shownTt.includes(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>`).join('')}</div>`,
      ]),
    ]],
    nav: ['route', 'Navigation', 'Routes, the junction view and speed warnings.', [
      group('Route', [
        row('Route type', '', seg('routeMode', [['fastest', 'Fastest'], ['shortest', 'Shortest'], ['smallRoads', 'Small roads']])),
        row('Route to the job automatically', 'When you take a job, Co-Driver guides you to it', sw('autoRouteJob')),
      ]),
      group('Junctions', [
        row('Zoom in before turns', 'The map zooms in before exits and interchanges', sw('junction.autoZoom')),
        row('How early', 'Seconds before the turn; busy interchanges get 40 % more', step('junction.leadSec', 6, 40, 1, 's'), 'junction.autoZoom'),
        row('Show lanes', 'Which lanes to use, on the banner', sw('junction.lanes')),
        row('Vibrate before a turn', 'A short buzz about 7 s before', sw('junction.vibrate')),
      ]),
      group('Speed', [
        row('Speeding warning', 'The speedometer turns red above the limit', sw('speeding.enabled')),
        row('Warn above the limit by', '', step('speeding.toleranceMph', 0, 20, 1, 'mph'), 'speeding.enabled'),
      ]),
    ]],
    stops: ['fuel', 'Stops', 'When Co-Driver suggests fuel, rest or a mechanic, and the Enter button.', [
      group('', [
        row('Suggestions', 'Ask: you tap to add it. Auto: added to your route by itself', seg('suggestions', [['ask', 'Ask me'], ['auto', 'Auto'], ['off', 'Off']])),
        row('Enter button', 'A big button when you stop at a company, pump, garage or parking', sw('actionPrompt.enabled')),
      ]),
      group('Fuel', [
        row('Fuel suggestions', '', sw('fuel.enabled')),
        row('Suggest fuel below', '', step('fuel.thresholdPct', 5, 75, 5, '%'), 'fuel.enabled'),
        row('Fuel stop type', '', seg('fuel.prefer', [['nearest', 'Any fuel'], ['withRest', 'Fuel + rest']]), 'fuel.enabled'),
      ]),
      group('Rest', [
        row('Rest suggestions', '', sw('rest.enabled')),
        row('Suggest rest when due within', '', step('rest.thresholdMin', 15, 240, 15, 'min'), 'rest.enabled'),
        row('Rest stop type', '', seg('rest.prefer', [['any', 'Any rest'], ['withFuel', 'Rest + fuel']]), 'rest.enabled'),
        row('Plan rest stops along the route', 'Picks the last good stop before your rest timer runs out', sw('rest.planOnRoute'), 'rest.enabled'),
        row('Use spare time to rest', 'Early for the delivery? Rest on the way', sw('rest.useSpareTime'), 'rest.enabled'),
        row('A rest takes', 'Game minutes', step('rest.durationMin', 60, 900, 30, 'min'), 'rest.enabled'),
      ]),
      group('Mechanic', [
        row('Mechanic suggestions', 'When your truck is damaged', sw('damage.enabled')),
        row('Suggest at damage', '', step('damage.thresholdPct', 2, 60, 1, '%'), 'damage.enabled'),
      ]),
    ]],
    voice: ['volUp', 'Voice', 'Spoken directions and announcements.', [
      group('', [
        row('Voice plays on', 'PC: in your headset with the game sound', seg('voice.output', [['pc', 'PC'], ['device', 'This tablet'], ['off', 'Off']])),
        row('Test', 'Hear how it sounds', '<button type="button" id="voiceTest" class="primary">▶ Test voice</button>'),
        row('PC voice', '', '<select id="pcVoiceSel" data-path="voice.pcVoice"><option value="">Best available (Amy)</option></select>'),
        row('Speak on this device', 'Only when "This tablet" is chosen', `<label class="sw"><input type="checkbox" id="speakHereChk" ${speakOnThisDevice() ? 'checked' : ''}><span></span></label>`),
      ]),
      group('What to say', [
        row('Turn-by-turn directions', '', sw('voice.guidance')),
        row('First call on the highway', 'How far before the turn', step('voice.earlyM', 500, 5000, 250, 'm'), 'voice.guidance'),
        row('Stops and arrival', '', sw('voice.stops')),
        row('Fuel, rest and mechanic suggestions', '', sw('voice.suggestions')),
      ]),
      group('Sound', [
        row('Speed', 'Slower ← 0 → faster', step('voice.rate', -10, 10, 1)),
        row('Volume', '', step('voice.volume', 0, 100, 5, '%')),
      ]),
    ]],
    eta: ['clock', 'Arrival', 'How the arrival time is worked out.', [
      group('Delivery window', [
        row('Window when you have not entered it', 'Delivery windows are usually 5 hours. 0 = none', step('delivery.windowHours', 0, 12, 1, 'h')),
      ]),
      group('Time at stops (game minutes)', [
        row('Fuel stop', '', step('eta.fuelStopMin', 0, 120, 5, 'min')),
        row('Mechanic', '', step('eta.serviceStopMin', 0, 180, 5, 'min')),
        row('Your own stops', '', step('eta.pointStopMin', 0, 240, 5, 'min')),
      ]),
      group('Traffic (real seconds)', [
        row('Wait per traffic light', '', step('eta.lightWaitSec', 0, 60, 1, 's')),
        row('Wait per stop sign', '', step('eta.stopSignWaitSec', 0, 30, 1, 's')),
      ]),
    ]],
    map: ['flag', 'Map', 'Which states are shown and used for routes.', [
      group('', [
        row('Show and route', '', seg('mapDlc', [['owned', 'States I own'], ['all', 'All states']])),
        `<div class="setRow"><div class="txt"><span id="mapDlcInfo">Checking which states the game loads…</span></div></div>`,
      ]),
    ]],
    camera: ['camera', 'Camera', 'The rear camera view.', [
      group('', [
        row('Rear camera', '', sw('camera.enabled')),
        row('Open when reversing', '', sw('camera.autoOnReverse'), 'camera.enabled'),
      ]),
    ]],
  };
  if (!TABS[setTab]) setTab = 'display';
  const [, title, intro, groups] = TABS[setTab];
  const keep = $('settingsForm').querySelector('.setBody')?.scrollTop ?? 0;
  $('settingsForm').innerHTML = `<nav class="setNav">${Object.entries(TABS).map(([k, [ic, l]]) => `<button type="button" data-tab="${k}" class="${k === setTab ? 'on' : ''}">${icon(ic)}${l}</button>`).join('')}</nav>
    <div class="setBody"><h3>${title}</h3><p class="intro">${intro}</p>${groups.join('')}</div>`;
  $('settingsForm').querySelector('.setBody').scrollTop = keep;
  $('settingsForm').querySelector('.setNav .on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  const save = (path, v) => {
    const patch = {};
    const ks = path.split('.');
    ks.reduce((o, k, i) => (o[k] = i === ks.length - 1 ? v : {}), patch);
    saveSettings(patch).then(() => { const el = $('setSaved'); el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 1400); });
  };
  $('settingsForm').querySelectorAll('[data-tab]').forEach(b => (b.onclick = () => { setTab = b.dataset.tab; $('settingsForm').querySelector('.setBody').scrollTop = 0; renderSettings(); }));
  $('settingsForm').querySelectorAll('[data-path]').forEach(el => el.addEventListener('change', () => save(el.dataset.path, el.type === 'checkbox' ? el.checked : el.value)));
  $('settingsForm').querySelectorAll('[data-seg]').forEach(g => g.querySelectorAll('button').forEach(b => (b.onclick = () => {
    g.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    save(g.dataset.seg, b.dataset.v);
  })));
  $('settingsForm').querySelectorAll('[data-step]').forEach(g => {
    const out = g.querySelector('output'), unit = out.querySelector('small')?.outerHTML ?? '';
    let v = Number(get(s, g.dataset.step)), timer = null;
    g.querySelectorAll('button').forEach(b => (b.onclick = () => {
      const st = Number(g.dataset.st);
      v = Math.min(Number(g.dataset.max), Math.max(Number(g.dataset.min), Math.round((v + st * Number(b.dataset.d)) / st) * st));
      out.innerHTML = v + unit;
      clearTimeout(timer); timer = setTimeout(() => save(g.dataset.step, v), 450);   // quick taps: one save
    }));
  });
  $('settingsForm').querySelectorAll('[data-tt]').forEach(el => el.addEventListener('change', () => {
    const telltales = TELLTALES.map(t => t.id).filter(id => $('settingsForm').querySelector(`[data-tt="${id}"]`).checked);
    saveSettings({ telltales });
  }));
  api('GET', '/api/mapdlc').then(d => {
    if (!d || !$('mapDlcInfo')) return;
    $('mapDlcInfo').textContent = d.detected
      ? `Owned (loaded by the game): California, ${d.owned.join(', ')}. Updates by itself after you buy a state and start the game.`
      : 'Could not read the game log yet, start the game once; until then all states are shown.';
  });
  api('GET', '/api/voices').then(list => {
    const sel = $('pcVoiceSel');
    if (!sel || !Array.isArray(list)) return;
    for (const name of list) sel.insertAdjacentHTML('beforeend', `<option value="${esc(name)}" ${settings.voice?.pcVoice === name ? 'selected' : ''}>${esc(name)}</option>`);
  });
  const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };   // controls exist on their own tab only
  on('speakHereChk', 'onchange', e => store.set('speakHere', e.target.checked));
  on('voiceTest', 'onclick', () => {
    if (settings.voice?.output === 'device') speakHere('In 400 feet, keep right towards I 5 North, Burlington. Use the two right lanes.', true, settings.voice.rate, settings.voice.volume);
    else api('POST', '/api/voice/test').then(() => toast('Speaking on the PC…'));
  });
  on('setCustomize', 'onclick', () => { $('settingsSheet').hidden = true; setEditing(true); });
  on('setFull', 'onclick', () => toggleFullscreen());
}
const get = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
async function saveSettings(patch) {
  const s = await api('PUT', '/api/settings', patch);
  if (s) applySettings(s);
}
// New settings (from this screen or another device): re-evaluate theme, rebuild the widgets.
function applySettings(s) {
  settings = s;
  currentNight = null;
  updateThemeButton();
  if (!editing) mountLayout();
  if (!$('settingsSheet').hidden) renderSettings();
  if (last) render(last);
}

// ------------------------------------------------------------------ server comms

async function api(method, url, body) {
  try {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return await r.json();
  } catch (e) { toast('Server not reachable'); return null; }
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'pos') { lastPosStream = performance.now(); camFix(m.p, ((1 - m.h) * 360) % 360, Math.abs(m.v)); }
    else if (m.type === 'state') render(m);
    else if (m.type === 'refuel') { refuelActive = m.active; if (!m.active && m.pct != null) toast(`Fuel ${Math.round(m.pct)} %`); if (last) renderPlace(last.here); }
    else if (m.type === 'hello') {
      applySettings(m.settings);
      showRoute(m.route);
      showSuggestion(m.suggestion);
    } else if (m.type === 'route') showRoute(m.route);
    else if (m.type === 'suggestion') showSuggestion(m.suggestion);
    else if (m.type === 'settings') applySettings(m.settings);
    else if (m.type === 'arrived') { toast((m.stop ? 'Stop reached: ' : 'Arrived: ') + m.name); navigator.vibrate?.([300, 100, 300]); }
    else if (m.type === 'notice') toast(m.text);
    else if (m.type === 'mapdata') reloadMapData();
    else if (m.type === 'say') speakHere(m.text, m.urgent, m.rate, m.volume);
  };
  ws.onclose = () => { $('connBadge').classList.remove('ok'); $('connBadge').textContent = 'Reconnecting to PC…'; setTimeout(connect, 1500); };
}

let toastTimer = 0;
function toast(msg) { $('toast').textContent = msg; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => ($('toast').hidden = true), 3000); }

// ---- behave like an app: no browser long-press menu, text selection or drag (the map keeps its own
// right-click / long-press destination menu; text fields keep theirs)
const isField = el => !!el?.closest?.('input, textarea, select, [contenteditable]');
document.addEventListener('contextmenu', e => { if (!isField(e.target)) e.preventDefault(); });
document.addEventListener('selectstart', e => { if (!isField(e.target)) e.preventDefault(); });
document.addEventListener('dragstart', e => { if (!isField(e.target) && !e.target.closest?.('.maplibregl-canvas-container')) e.preventDefault(); });
// pinch-zooming the whole page (instead of the map) on tablets
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('touchmove', e => { if (e.touches.length > 1 && !e.target.closest?.('#map')) e.preventDefault(); }, { passive: false });

// ---- voice on this device (Settings → Voice → "This phone / tablet")
// Each dashboard can opt out ("Speak on this device"), so only the tablet in the car talks.
const speakOnThisDevice = () => store.get('speakHere', true);
function speakHere(text, urgent, rate = 0, volume = 90) {
  if (!speakOnThisDevice() || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = Math.max(0.5, Math.min(2, 1 + rate / 10));
  u.volume = Math.max(0, Math.min(1, volume / 100));
  const v = speechSynthesis.getVoices().find(v => v.lang?.startsWith('en') && /natural|google|neural/i.test(v.name)) || speechSynthesis.getVoices().find(v => v.lang?.startsWith('en'));
  if (v) u.voice = v;
  if (urgent) speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// ---- keep the screen on while this tab is open and in front (never in the background)
// The Screen Wake Lock API only exists on HTTPS pages; the dashboard is opened as plain
// http://<pc>:8080, where browsers drop it silently and the tablet went to sleep. Fallback: a tiny
// muted looping video, browsers keep the screen on while a video plays in the visible tab and pause
// it when the tab is hidden, so it never keeps a backgrounded tab awake.
let wakeLock = null, wakeVideo = null;
function wakeVideoEl() {
  if (wakeVideo) return wakeVideo;
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  let n = 0;
  setInterval(() => { if (document.visibilityState === 'visible') { g.fillStyle = n++ % 2 ? '#000' : '#010101'; g.fillRect(0, 0, 16, 16); } }, 1000);
  wakeVideo = document.createElement('video');
  wakeVideo.muted = true; wakeVideo.loop = true; wakeVideo.playsInline = true;
  wakeVideo.setAttribute('playsinline', ''); wakeVideo.setAttribute('aria-hidden', 'true');
  // behind the app (still "on screen" for the browser, invisible to you)
  wakeVideo.style.cssText = 'position:fixed;left:0;bottom:0;width:64px;height:64px;opacity:.01;pointer-events:none;z-index:-1';
  wakeVideo.srcObject = c.captureStream(1);
  document.body.appendChild(wakeVideo);
  return wakeVideo;
}
async function keepAwake() {
  if (settings && settings.keepAwake === false) return releaseAwake();
  if (document.visibilityState !== 'visible') return;
  if ('wakeLock' in navigator && window.isSecureContext) {
    try {
      if (!wakeLock || wakeLock.released) wakeLock = await navigator.wakeLock.request('screen');
      return;
    } catch { /* not allowed right now → video fallback */ }
  }
  try { await wakeVideoEl().play(); } catch { /* needs a tap first; retried on the next tap */ }
}
function releaseAwake() {
  try { wakeLock?.release(); } catch { /* already released */ }
  wakeLock = null;
  wakeVideo?.pause();
}
document.addEventListener('pointerdown', keepAwake);
document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? keepAwake() : releaseAwake()));
keepAwake();

fetch('/api/favourites').then(r => r.json()).then(renderFavourites).catch(() => {});
// Connect right away: gauges, controls and job info must work even if the map is slow or fails.
connect();
