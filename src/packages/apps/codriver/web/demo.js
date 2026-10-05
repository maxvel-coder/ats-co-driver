'use strict';
/* Demo mode (open the app with ?demo): fakes the Co-Driver server and the game so the dashboard
   can be looked at and customized without ATS running. Replaces WebSocket and /api/* fetches. */
(() => {
  let demoSettings = {
    units: 'imperial', theme: 'night', routeMode: 'fastest', autoRouteJob: true, suggestions: 'ask',
    fuel: { enabled: true, thresholdPct: 25, prefer: 'nearest' },
    rest: { enabled: true, thresholdMin: 60, prefer: 'any', planOnRoute: true, useSpareTime: true, durationMin: 600 },
    speeding: { enabled: true, toleranceMph: 5 },
    junction: { autoZoom: true, leadSec: 15, lanes: true, vibrate: true },
    camera: { enabled: true, autoOnReverse: true },
    buttons: ['lblinker', 'light', 'hblight', 'wipers', 'flasher4way', 'parkingbrake', 'cruiectrl', 'engine', 'horn', 'rblinker'],
    layouts: JSON.parse(localStorage.getItem('demoLayouts') || '{}'), telltales: null, telltalesHideOff: false,
  };
  const qs = new URLSearchParams(location.search);
  if (qs.get('theme')) demoSettings.theme = qs.get('theme');
  const merge = (a, b) => { if (!b || typeof b !== 'object' || Array.isArray(b)) return b ?? a; const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = a?.[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? merge(a[k], v) : v; return o; };
  const lane = (branches, active) => ({ branches, active });
  const job = { id: 'job', name: 'Drake Car Dealer, Burlington', kind: 'job', lngLat: [-118.4, 35.65] };
  let own = [
    { id: 'a', name: 'Fuel + rest stop (I-5)', kind: 'fuel', lngLat: [-118.75, 35.3] },
    { id: 'b', name: 'Map point', kind: 'point', lngLat: [-119.25, 35.55] },
  ];
  const at = [-119.6, 35.2];
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  // same idea as the server: try every order, shortest trip from the car to the job wins
  function order(ws) {
    let best = ws, bc = Infinity;
    const perm = (rest, acc) => {
      if (!rest.length) { let c = 0, p = at; for (const w of acc) { c += d(p, w.lngLat); p = w.lngLat; } c += d(p, job.lngLat); if (c < bc) { bc = c; best = acc; } return; }
      rest.forEach((w, i) => perm([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, w]));
    };
    perm(ws, []);
    return best;
  }
  function makeRoute() {
    const list = [...order(own), job];
    const stops = list.map((s, i) => ({ ...s, n: i + 1, final: i === list.length - 1 }));
    return { destination: stops.at(-1), stops, hasJob: true, finalIsJob: true, line: [at, ...stops.map(s => s.lngLat)], distance: 180000, duration: 9000, steps: [] };
  }
  let route = makeRoute();
  let ws = null, lastSug = null;
  const pushRoute = () => { route = makeRoute(); ws?.onmessage?.({ data: JSON.stringify({ type: 'route', route }) }); };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const json = v => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } });
    if (u.startsWith('/api/settings')) {
      if (opts.method === 'PUT') { demoSettings = merge(demoSettings, JSON.parse(opts.body)); localStorage.setItem('demoLayouts', JSON.stringify(demoSettings.layouts)); }
      return json(demoSettings);
    }
    if (u.startsWith('/api/favourites')) return json([{ id: '1', name: 'Home depot', lngLat: [-122.3, 47.6] }, { id: '2', name: 'Truck stop I-5', lngLat: [-122.2, 47.4] }]);
    if (u.startsWith('/api/cities')) return json([]);
    if (u.startsWith('/api/route/stop/')) { const id = decodeURIComponent(u.split('/').pop()); own = own.filter(s => s.id !== id); pushRoute(); return json(route); }
    if (u === '/api/route' && opts.method === 'POST') {
      const b = JSON.parse(opts.body);
      const s = { id: String(Date.now()), name: b.name, kind: b.kind || 'point', lngLat: b.lngLat };
      own = b.mode === 'replace' ? [s] : [...own, s];
      pushRoute(); return json(route);
    }
    if (u === '/api/route' && opts.method === 'DELETE') { own = []; pushRoute(); return json(route); }
    if (u === '/api/suggest') {
      const kind = JSON.parse(opts.body).kind;
      lastSug = { kind, reason: kind === 'service' ? 'Damage 15% (body). Get it repaired' : 'Easiest stop to add to your route',
        stop: { name: kind === 'service' ? 'Service station (Bakersfield)' : 'Fuel station', lngLat: [-119.0, 35.45], facilities: ['service_ico', 'gas_ico'], distance: 30000, duration: 1500, detour: 420 } };
      ws?.onmessage?.({ data: JSON.stringify({ type: 'suggestion', suggestion: lastSug }) });
      return json(lastSug.stop);
    }
    if (u === '/api/suggestion/accept' && lastSug) { own = [...own, { id: 's' + Date.now(), name: lastSug.stop.name, kind: lastSug.kind, lngLat: lastSug.stop.lngLat }]; lastSug = null; pushRoute(); return json({}); }
    if (u.startsWith('/api/')) return json({ error: 'Demo mode' });
    if (u.startsWith('/sprites')) return json({});
    return realFetch(url, opts);
  };
  class FakeWS {
    constructor() {
      this.readyState = 1;
      ws = this;
      setTimeout(() => {
        this.onmessage?.({ data: JSON.stringify({ type: 'hello', settings: demoSettings, route, suggestion: null }) });
        let t = 0;
        this.timer = setInterval(() => { t += 0.2; this.onmessage?.({ data: JSON.stringify(state(t)) }); }, 200);
      }, 50);
    }
    send(m) { console.log('demo press', m); }
    close() {}
  }
  window.WebSocket = FakeWS;
  function state(t) {
    const speed = 26 + Math.sin(t / 4) * 6;          // m/s ≈ 58 mph ± 13
    const gear = speed > 22 ? 6 : 5;
    return {
      type: 'state', connected: true, paused: false, lngLat: null,
      truck: { 'rpm.limit': 6500, 'fuel.capacity': 60 },
      ch: {
        'truck.speed': speed, 'truck.engine.rpm': 1800 + (speed - 20) * 160 + Math.sin(t) * 80, 'truck.displayed.gear': gear,
        'truck.navigation.speed.limit': 29.06, 'truck.cruise_control': t % 20 > 10 ? 26.8 : 0,
        'truck.fuel.range': 210, 'truck.fuel.warning': false, 'rest.stop': 95, 'game.time': 6 * 1440 + 16 * 60 + 20 + t,
        'truck.engine.enabled': true, 'truck.electric.enabled': true, 'truck.light.beam.low': true, 'truck.light.beam.high': false,
        'truck.lblinker': t % 12 < 4, 'truck.rblinker': false, 'truck.hazard.warning': false, 'truck.brake.parking': false,
        'truck.wipers': false, 'truck.light.beacon': false,
      },
      fuelPct: 22,
      jobProgress: { value: Math.min(1, 0.35 + t / 900), leftM: 96000 - t * 30, plannedM: 150000 },
      // a car driving north-east at ~60 mph, for the smooth camera (?drive)
      lngLat: qs.has('drive') ? [-119.6 + t * 0.00022, 35.2 + t * 0.00012] : null,
      // ?here=company|service|fuel|rest[&engine=1] shows the "Enter" helper
      here: qs.get('here') ? {
        company: { kind: 'company', name: 'Drake Car Dealer, Burlington', action: 'Deliver cargo', needEngineOff: false, engineOn: true, jobPlace: true },
        service: { kind: 'service', name: 'Service station (Bakersfield)', action: 'Refuel · Repair · Sleep', needEngineOff: false, engineOn: true },
        fuel: { kind: 'fuel', name: 'Fuel station', action: 'Refuel', needEngineOff: true, engineOn: qs.has('engine') },
        rest: { kind: 'rest', name: 'Rest area (I-5)', action: 'Sleep', needEngineOff: true, engineOn: qs.has('engine') },
      }[qs.get('here')] : null,
      plan: (() => {
        const kinds = route.stops.map(x => x.kind);
        let t = 0;
        const stops = route.stops.map((x, i) => { t += 35 + i * 12; const stay = x.final ? 0 : { fuel: 15, service: 25 }[x.kind] ?? 0; const o = { id: x.id, name: x.name, kind: x.kind, n: i + 1, arriveMin: t, stayMin: stay }; t += stay; return o; });
        return { stops, totalMin: stops.at(-1).arriveMin, driveMin: 140, waitMin: 7, stopMin: stops.reduce((a, x) => a + x.stayMin, 0), lights: 11, signs: 4, cal: 1, kinds };
      })(),
      damage: { parts: { engine: 3.2, transmission: 1.1, body: 14.6, chassis: 6, wheels: 2.4 }, worst: 'body', max: 14.6 },
      job: { cargo: 'Used cars', from: 'Bushnell Farms, Seattle', to: 'Drake Car Dealer, Burlington', income: 4820, plannedKm: 96, cargoDamage: 2.4, cargoMass: 3400 },
      timing: { now: 6 * 1440 + 16 * 60, due: 6 * 1440 + 20 * 60 + 16, dueIn: 256, eta: 172, etaSource: 'dashlink', earliest: 6 * 1440 + 18 * 60 + 6, spare: 84, early: qs.get('early') ? 14 : null },
      restPlan: { type: 'spare', name: 'Fuel + rest stop (I-5)', etaMin: 48, detail: 'You have 1h 26m spare, optional rest before the delivery window.' },
      nav: {
        progress: Math.min(1, 0.42 + t / 600), remaining: 96000, eta: 9000, toNext: 380 - ((t * 25) % 380), nextIndex: 3, offRoute: false,
        next: { direction: '11', banner: 'I-5 N · Burlington', distance: 300, lngLat: [0, 0], lanes: [lane([0], undefined), lane([0], undefined), lane([0, 11], 11), lane([11], 11)] },
        after: { direction: '12', distance: 800 },
      },
      events: [{ id: 'player.tollgate.paid', attr: { 'pay.amount': 6 } }, { id: 'job.delivered', attr: { revenue: 3900 } }],
    };
  }
})();
