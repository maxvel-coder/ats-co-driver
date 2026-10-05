'use strict';
/* ATS Co-Driver widgets: every gauge, card and switch is a widget the driver can place in one of four
   zones (Customize mode: drag to move, ✕ to remove, ＋ to add). The layout is saved per device
   type and orientation in the server settings (settings.layouts), so phone/tablet and
   portrait/landscape each keep their own arrangement.
   Loaded before app.js; uses app.js globals (settings, last, route, press, api …) at runtime only. */

// ------------------------------------------------------------------ icons (24×24 line icons)

const ICONS = {
  power: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  battery: '<rect x="3" y="7" width="18" height="12" rx="2"/><path d="M7 7V5h3v2M14 7V5h3v2M6.5 13H10M14 13h3.5M15.75 11.25v3.5"/>',
  lowbeam: '<path d="M14 5c3.9 0 7 3.1 7 7s-3.1 7-7 7c-1.1 0-2-.9-2-2V7c0-1.1.9-2 2-2z"/><path d="M9 8 3 10M9 12 3 14M9 16l-6 2"/>',
  highbeam: '<path d="M14 5c3.9 0 7 3.1 7 7s-3.1 7-7 7c-1.1 0-2-.9-2-2V7c0-1.1.9-2 2-2z"/><path d="M9 8H3M9 12H3M9 16H3"/>',
  left: '<path d="M10 5 3 12l7 7v-4h11V9H10z" fill="currentColor" stroke="none"/>',
  right: '<path d="m14 5 7 7-7 7v-4H3V9h11z" fill="currentColor" stroke="none"/>',
  hazard: '<path d="M12 3 2 20h20z"/><path d="M12 9.5 7.5 17h9z"/>',
  wipers: '<path d="M2 17c2.5-5 6-7.5 10-7.5S19.5 12 22 17"/><path d="M12 20 6.5 11"/><circle cx="12" cy="20" r="1.2" fill="currentColor"/>',
  park: '<circle cx="12" cy="12" r="6.5"/><path d="M10.2 15.5v-7h2.3a2 2 0 0 1 0 4h-2.3"/><path d="M4.5 6a10 10 0 0 0 0 12M19.5 6a10 10 0 0 1 0 12"/>',
  cruise: '<path d="M4.5 17a8 8 0 1 1 15 0"/><path d="m12 13 4-4"/><circle cx="12" cy="13" r="1.3" fill="currentColor"/>',
  cruisePlus: '<path d="M3.5 17a8 8 0 0 1 12.6-8.6"/><path d="m10 13 3-3"/><path d="M19 9v6M16 12h6"/>',
  cruiseMinus: '<path d="M3.5 17a8 8 0 0 1 12.6-8.6"/><path d="m10 13 3-3"/><path d="M16 12h6"/>',
  horn: '<path d="M3 10v4h3l8 5V5L6 10z"/><path d="M17 9a4 4 0 0 1 0 6M19.5 6.5a8 8 0 0 1 0 11"/>',
  beacon: '<path d="M7 18v-5a5 5 0 0 1 10 0v5"/><path d="M5 18h14v3H5z"/><path d="M12 3v2M4.5 6.5 6 8M19.5 6.5 18 8"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>',
  camera: '<path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/>',
  video: '<rect x="2" y="7" width="14" height="10" rx="2"/><path d="m16 11 6-3.5v9L16 13"/>',
  radio: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M7 8l10-5"/><circle cx="8.5" cy="14" r="2.5"/><path d="M14 12h4M14 16h4"/>',
  windowL: '<path d="M4 19V9.5L9 5h11v14z"/><path d="M13 9v6m-2.5-2.5L13 15l2.5-2.5"/>',
  windowR: '<path d="M20 19V9.5L15 5H4v14z"/><path d="M11 9v6m-2.5-2.5L11 15l2.5-2.5"/>',
  mirror: '<path d="M3 8h10a4 4 0 0 1 0 8H3z"/><path d="M17 12h4"/>',
  shot: '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><circle cx="12" cy="12" r="3"/>',
  fuel: '<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M6.5 8h5"/><path d="M14 11h2a2 2 0 0 1 2 2v3.5a1.5 1.5 0 0 0 3 0V8l-3-3"/>',
  bed: '<path d="M3 19V6M3 15h18v4M21 15v-2.5A3.5 3.5 0 0 0 17.5 9H11v6"/><circle cx="7" cy="12" r="2"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 5 5"/>',
  box: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  flag: '<path d="M5 21V4h12l-2.5 4L17 12H5"/>',
  route: '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h8a3 3 0 0 0 0-6H8a3 3 0 0 1 0-6h8"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  widgets: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><path d="M17.25 14v6.5M14 17.25h6.5"/>',
  locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  full: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
  auto: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>',
  speedo: '<path d="M4.5 17a8 8 0 1 1 15 0"/><path d="m12 13 3.5-5"/>',
  gearbox: '<circle cx="6" cy="6" r="1.6"/><circle cx="12" cy="6" r="1.6"/><circle cx="18" cy="6" r="1.6"/><circle cx="6" cy="18" r="1.6"/><circle cx="12" cy="18" r="1.6"/><path d="M6 7.6v8.8M12 7.6v8.8M18 7.6V12H6"/>',
  sign: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 15h6"/>',
  lights: '<circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L21 12.6a6 6 0 0 1-7.4 1.8L7 21a2.1 2.1 0 0 1-3-3l6.6-6.6A6 6 0 0 1 12.4 4L13.7 5.3a4 4 0 0 0 1 1z"/>',
  volUp: '<path d="M3 10v4h3l5 4V6l-5 4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/><path d="M19 12h4M21 10v4"/>',
  volDown: '<path d="M3 10v4h3l5 4V6l-5 4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/><path d="M19 12h4"/>',
  prev: '<path d="M6 5v14"/><path d="M19 5 9 12l10 7z" fill="currentColor" stroke="none"/>',
  next: '<path d="M18 5v14"/><path d="m5 5 10 7-10 7z" fill="currentColor" stroke="none"/>',
  dot: '<circle cx="12" cy="12" r="3" fill="currentColor"/>',
};
const icon = n => `<svg class="i" viewBox="0 0 24 24">${ICONS[n] || ICONS.dot}</svg>`;

// ------------------------------------------------------------------ game controls (switches)

// on(): telemetry state shown by the switch's LED; color: LED/icon colour when on (default green).
// SDK note: truck.lblinker / truck.rblinker are the indicator *switch* states (steady while on),
// so the blinking is done in CSS.
const CTL = {
  engine: { icon: 'power', label: 'Engine', on: ch => ch['truck.engine.enabled'] },
  engineelect: { icon: 'battery', label: 'Electrics', on: ch => ch['truck.electric.enabled'], color: 'amber' },
  light: { icon: 'lowbeam', label: 'Lights', on: ch => ch['truck.light.beam.low'] },
  hblight: { icon: 'highbeam', label: 'High beam', on: ch => ch['truck.light.beam.high'], color: 'blue' },
  lblinker: { icon: 'left', label: 'Left', on: ch => ch['truck.lblinker'] && !ch['truck.hazard.warning'], blink: true },   // hazards win: only the hazard light blinks
  rblinker: { icon: 'right', label: 'Right', on: ch => ch['truck.rblinker'] && !ch['truck.hazard.warning'], blink: true },
  flasher4way: { icon: 'hazard', label: 'Hazards', on: ch => ch['truck.hazard.warning'], color: 'red', blink: true },
  wipers: { icon: 'wipers', label: 'Wipers', on: ch => ch['truck.wipers'] },
  parkingbrake: { icon: 'park', label: 'Park brake', on: ch => ch['truck.brake.parking'], color: 'red' },
  cruiectrl: { icon: 'cruise', label: 'Cruise', on: ch => (ch['truck.cruise_control'] ?? 0) > 0 },
  cruiectrlinc: { icon: 'cruisePlus', label: 'Cruise +' },
  cruiectrldec: { icon: 'cruiseMinus', label: 'Cruise −' },
  horn: { icon: 'horn', label: 'Horn' },
  beacon: { icon: 'beacon', label: 'Beacon', on: ch => ch['truck.light.beacon'], color: 'amber' },
  cabinlight: { icon: 'bulb', label: 'Cabin light' },
  parking_cams: { icon: 'camera', label: 'Park cams' },
  cam1: { icon: 'video', label: 'Cabin cam' },
  cam2: { icon: 'video', label: 'Chase cam' },
  camcycle: { icon: 'video', label: 'Next cam' },
  radiotoggle: { icon: 'radio', label: 'Radio', on: () => radioOn },   // state kept by the app (the game doesn't report it)
  radioprev: { icon: 'prev', label: 'Prev station' },
  radionext: { icon: 'next', label: 'Next station' },
  radiodown: { icon: 'volDown', label: 'Volume −' },
  radioup: { icon: 'volUp', label: 'Volume +' },
  lwinopen: { icon: 'windowL', label: 'Window L' },
  rwinopen: { icon: 'windowR', label: 'Window R' },
  showmirrors: { icon: 'mirror', label: 'Mirrors' },
  screenshot: { icon: 'shot', label: 'Screenshot' },
};

// Warning lights for the telltale widget, in dashboard order (left indicator first, right last).
const TELLTALES = [
  { id: 'left', name: 'Left indicator', icon: 'left', color: 'green', blink: true, on: ch => ch['truck.lblinker'] && !ch['truck.hazard.warning'] },
  { id: 'lowbeam', name: 'Low beam', icon: 'lowbeam', color: 'green', on: ch => ch['truck.light.beam.low'] },
  { id: 'highbeam', name: 'High beam', icon: 'highbeam', color: 'blue', on: ch => ch['truck.light.beam.high'] },
  { id: 'hazard', name: 'Hazards', icon: 'hazard', color: 'red', blink: true, on: ch => ch['truck.hazard.warning'] },
  { id: 'park', name: 'Parking brake', icon: 'park', color: 'red', on: ch => ch['truck.brake.parking'] },
  { id: 'cruise', name: 'Cruise control', icon: 'cruise', color: 'green', on: ch => (ch['truck.cruise_control'] ?? 0) > 0 },
  { id: 'wipers', name: 'Wipers', icon: 'wipers', color: 'green', on: ch => ch['truck.wipers'] },
  { id: 'beacon', name: 'Beacon', icon: 'beacon', color: 'amber', on: ch => ch['truck.light.beacon'] },
  { id: 'fuel', name: 'Low fuel', icon: 'fuel', color: 'amber', on: ch => ch['truck.fuel.warning'] },
  { id: 'damage', name: 'Damage (needs repair)', icon: 'wrench', color: 'amber', on: (ch, s) => (s?.damage?.max ?? 0) >= (settings?.damage?.thresholdPct ?? 10) },
  { id: 'engine', name: 'Engine off', icon: 'power', color: 'red', on: ch => ch['truck.electric.enabled'] && !ch['truck.engine.enabled'] },
  { id: 'right', name: 'Right indicator', icon: 'right', color: 'green', blink: true, on: ch => ch['truck.rblinker'] && !ch['truck.hazard.warning'] },
];

// ------------------------------------------------------------------ widget catalogue

const ZONES = ['quick', 'cluster', 'side', 'dock'];
const ZONE_LABEL = { quick: 'Map shortcuts', cluster: 'Instrument cluster', side: 'Side panel', dock: 'Dock' };
const BTN_ZONES = ['dock', 'quick', 'side'];
const GAUGE_ZONES = ['cluster', 'side', 'quick'];
const CARD_ZONES = ['side'];

const setText = (el, sel, v) => { const n = el.querySelector(sel); if (n && n.textContent !== String(v)) n.textContent = v; };
const tog = (el, cls, on) => el.classList.toggle(cls, !!on);

// 270° arc used by the speedometer and the rev ring (opens at the bottom).
function arcPath(cx, cy, r) {
  const a0 = (135 * Math.PI) / 180, a1 = (45 * Math.PI) / 180;
  const p = a => `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
  return `M${p(a0)} A${r} ${r} 0 1 1 ${p(a1)}`;
}
function arcPoint(cx, cy, r, frac) {
  const a = ((135 + 270 * Math.max(0, Math.min(1, frac))) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

const SPEEDO_ARC = arcPath(68, 64, 54);
const REV_ARC = arcPath(52, 50, 42);
// Real arc lengths (270° of the circle): dash offsets are in path units, some browsers ignore
// pathLength for stroke-dashoffset, so the gauges compute with true lengths.
const SPEEDO_LEN = 54 * 1.5 * Math.PI, REV_LEN = 42 * 1.5 * Math.PI;
const arcDash = (len, frac) => String((len * (1 - Math.max(0, Math.min(1, frac)))).toFixed(1));

const W = {
  speed: {
    name: 'Speedometer', group: 'Instruments', icon: 'speedo', zones: GAUGE_ZONES, cls: z => 'gauge' + (z === 'side' ? ' half' : ''),
    html: () => {
      const ticks = Array.from({ length: 11 }, (_, i) => { const [x1, y1] = arcPoint(68, 64, 44, i / 10), [x2, y2] = arcPoint(68, 64, 39, i / 10); return `<line class="tick" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke-width="1.5"/>`; }).join('');
      return `<svg class="speedo" viewBox="0 0 136 112"><path class="track" d="${SPEEDO_ARC}" fill="none" stroke-width="9" stroke-linecap="round"/>
        <path class="val" d="${SPEEDO_ARC}" fill="none" stroke-width="9" stroke-linecap="round" stroke-dasharray="${SPEEDO_LEN.toFixed(1)} 999" stroke-dashoffset="${SPEEDO_LEN.toFixed(1)}"/>
        ${ticks}<line class="lim" x1="0" y1="0" x2="0" y2="0" stroke-width="4" stroke-linecap="round" visibility="hidden"/>
        <text class="big" x="68" y="72">0</text><text class="unit" x="68" y="88">mph</text><text class="unit cc" x="68" y="108"></text></svg>`;
    },
    update(el, s) {
      const ch = s.ch || {}, v = fmtSpeed(ch['truck.speed'] ?? 0), max = imperial() ? 90 : 150;
      setText(el, '.big', ch['truck.speed'] != null ? v : '–');
      setText(el, '.unit', speedUnit());
      el.querySelector('.val').style.strokeDashoffset = arcDash(SPEEDO_LEN, v / max) + 'px';
      const lim = ch['truck.navigation.speed.limit'], line = el.querySelector('.lim');
      if (lim) {
        const f = fmtSpeed(lim) / max, [x1, y1] = arcPoint(68, 64, 47, f), [x2, y2] = arcPoint(68, 64, 61, f);
        line.setAttribute('x1', x1); line.setAttribute('y1', y1); line.setAttribute('x2', x2); line.setAttribute('y2', y2);
        line.setAttribute('visibility', 'visible');
      } else line.setAttribute('visibility', 'hidden');
      const cc = ch['truck.cruise_control'] ?? 0;
      setText(el, '.cc', cc > 0 ? `CC ${fmtSpeed(cc)}` : '');
      tog(el, 'over', isSpeeding(ch));
    },
  },
  revs: {
    name: 'Gear + revs', group: 'Instruments', icon: 'gearbox', zones: GAUGE_ZONES, cls: z => 'gauge' + (z === 'side' ? ' half' : ''),
    html: () => `<svg class="revs" viewBox="0 0 104 104"><path class="track" d="${REV_ARC}" fill="none" stroke-width="7" stroke-linecap="round"/>
      <path class="red" d="${REV_ARC}" fill="none" stroke-width="7" stroke-dasharray="0 ${(REV_LEN * 0.86).toFixed(1)} ${(REV_LEN * 0.14).toFixed(1)} 999"/>
      <path class="val" d="${REV_ARC}" fill="none" stroke-width="7" stroke-linecap="round" stroke-dasharray="${REV_LEN.toFixed(1)} 999" stroke-dashoffset="${REV_LEN.toFixed(1)}"/>
      <text class="gear" x="52" y="64">N</text><text class="rpm" x="52" y="98">0 rpm</text></svg>`,
    update(el, s) {
      const ch = s.ch || {}, rpm = ch['truck.engine.rpm'] ?? 0, max = s.truck?.['rpm.limit'] || 6500;
      const g = ch['truck.displayed.gear'];
      setText(el, '.gear', g == null ? '–' : g < 0 ? 'R' : g === 0 ? 'N' : g);
      setText(el, '.rpm', `${(rpm / 1000).toFixed(1)}k rpm`);
      const f = Math.min(1, rpm / max);
      el.querySelector('.val').style.strokeDashoffset = arcDash(REV_LEN, f) + 'px';
      tog(el, 'redline', f > 0.86);
      tog(el, 'rev', g != null && g < 0);
    },
  },
  fuel: {
    name: 'Fuel', group: 'Instruments', icon: 'fuel', zones: GAUGE_ZONES, cls: z => 'bargauge gauge' + (z === 'side' ? ' half' : ''),
    html: () => `<div class="bgTop">${icon('fuel')}<b>–</b><span class="sub">–</span></div><div class="segs">${'<i></i>'.repeat(10)}</div><div class="bgScale"><span>E</span><span>½</span><span>F</span></div>`,
    update(el, s) {
      const fp = s.fuelPct, ch = s.ch || {};
      // range is the number that matters; the bar already shows how full the tank is
      const range = ch['truck.fuel.range'];
      setText(el, 'b', range != null ? fmtDist(range * 1000) : fp != null ? Math.round(fp) + '%' : '–');
      setText(el, '.sub', range != null && fp != null ? Math.round(fp) + '%' : '');
      el.querySelectorAll('.segs i').forEach((seg, i) => tog(seg, 'on', fp != null && fp > i * 10 + 2));
      tog(el, 'low', fp != null && settings && fp <= settings.fuel.thresholdPct);
      tog(el, 'crit', fp != null && fp <= 10);
    },
  },
  rest: {
    name: 'Rest timer', group: 'Instruments', icon: 'bed', zones: GAUGE_ZONES, cls: z => 'bargauge gauge' + (z === 'side' ? ' half' : ''),
    html: () => `<div class="bgTop">${icon('bed')}<b>–</b><span class="sub">rest in</span></div><div class="segs">${'<i></i>'.repeat(10)}</div>`,
    update(el, s) {
      const r = s.ch?.['rest.stop'], ok = typeof r === 'number' && r >= 0;
      setText(el, 'b', ok ? fmtDurShort(r * 60) : '–');
      el.querySelectorAll('.segs i').forEach((seg, i) => tog(seg, 'on', ok && r / 660 > i / 10));
      tog(el, 'low', ok && settings && r <= settings.rest.thresholdMin);
      tog(el, 'crit', ok && r <= 30);
    },
  },
  damage: {
    name: 'Vehicle damage', group: 'Instruments', icon: 'wrench', zones: GAUGE_ZONES, cls: z => 'bargauge gauge damage' + (z === 'side' ? ' half' : ''),
    html: () => `<div class="bgTop">${icon('wrench')}<b>–</b><span class="sub">–</span></div><div class="segs">${'<i></i>'.repeat(10)}</div>`,
    tap: () => toggleDamageDetail(),
    update(el, s) {
      const d = s.damage;
      setText(el, 'b', d ? Math.round(d.max) + '%' : '–');
      setText(el, '.sub', d ? (d.max < 1 ? 'no damage' : d.worst) : '');
      // segments fill with damage (10 % each); amber from the warning threshold, red from 3× it
      el.querySelectorAll('.segs i').forEach((seg, i) => tog(seg, 'on', d && d.max > i * 10 + 0.5));
      const th = settings?.damage?.thresholdPct ?? 10;
      tog(el, 'low', d && d.max >= th);
      tog(el, 'crit', d && d.max >= th * 3);
      el.title = d ? Object.entries(d.parts).map(([k, v]) => `${k} ${v}%`).join(' · ') : '';
    },
  },
  clock: {
    name: 'Game clock', group: 'Instruments', icon: 'clock', zones: [...GAUGE_ZONES, 'dock'], cls: z => 'clock gauge' + (z === 'side' ? ' half' : ''),
    html: () => `<span>–</span><b>–</b>`,
    update(el, s) {
      const t = hereTime(s, s.ch?.['game.time']);   // local time where the car is
      setText(el, 'span', t.slice(0, 3)); setText(el, 'b', t.slice(4) || '–');
    },
  },
  limit: {
    name: 'Speed limit sign', group: 'Instruments', icon: 'sign', zones: GAUGE_ZONES, cls: z => 'limit gauge' + (z === 'side' ? ' cell' : ''),
    html: () => `<div class="limitSign"><small>SPEED<br>LIMIT</small><b>–</b></div>`,
    update(el, s) {
      const lim = s.ch?.['truck.navigation.speed.limit'];
      setText(el, 'b', lim ? fmtSpeed(lim) : '–');
      tog(el.querySelector('.limitSign'), 'round', !imperial());
      tog(el, 'none', !lim);
      tog(el, 'over', isSpeeding(s.ch || {}));
    },
  },
  telltales: {
    name: 'Warning lights', group: 'Instruments', icon: 'lights', zones: ['cluster', 'side', 'dock'], cls: z => 'telltales' + (z === 'side' ? ' card' : ''),
    html: () => {
      const shown = settings?.telltales ?? TELLTALES.map(t => t.id);
      return TELLTALES.filter(t => shown.includes(t.id)).map(t => `<span class="tt ${t.color}${t.blink ? ' blink' : ''}" data-tt="${t.id}" title="${t.name}">${icon(t.icon)}</span>`).join('');
    },
    update(el, s) {
      const ch = s.ch || {};
      for (const n of el.querySelectorAll('.tt')) { const t = TELLTALES.find(x => x.id === n.dataset.tt); tog(n, 'on', t?.on(ch, s)); }
    },
  },

  // ---------------------------------------------------------------- cards
  trip: {
    name: 'Route & ETA', group: 'Navigation', icon: 'route', zones: CARD_ZONES, cls: () => 'card',
    html: () => `<div class="cardHead">${icon('flag')}<span class="kind grow">Route</span><button class="tojob" hidden>Route to job</button><button class="end">End</button></div>
      <div class="cardBody"><div class="tripMain"><b class="eta">–</b><span class="muted dist">–</span><span class="muted arr"></span></div>
      <div class="progLine"><div class="pbar"><i></i></div><b class="pct"></b></div>
      <div class="tripStops"></div><div class="tripDest">–</div></div>`,
    init(el) {
      el.querySelector('.end').onclick = e => { e.stopPropagation(); if (!editing) api('DELETE', '/api/route'); };
      el.querySelector('.tojob').onclick = e => { e.stopPropagation(); if (!editing) api('POST', '/api/route/job').then(r => r?.error && toast(r.error)); };
    },
    update(el, s) {
      const on = !!(route && s.nav);
      tog(el, 'empty', !route);
      el.querySelector('.end').hidden = !route;
      el.querySelector('.tojob').hidden = !!route || !s.job;
      if (!route) {
        setText(el, '.kind', 'No route'); setText(el, '.eta', ''); setText(el, '.dist', ''); setText(el, '.arr', '');
        el.querySelector('.tripStops').innerHTML = '';
        setText(el, '.tripDest', 'Long-press the map to set a destination');
        el.querySelector('.progLine').hidden = true;
        return;
      }
      const stops = route.stops || [], mid = stops.filter(x => !x.final);
      const own = stops.some(x => x.kind !== 'job');
      // "Clear stops" keeps the job route; plain "End" switches guidance off
      setText(el, '.end', own && route.hasJob ? 'Clear stops' : 'End');
      const finalKind = { job: 'Delivery', fuel: 'Fuel stop', rest: 'Rest stop', favourite: 'Favourite' }[route.destination.kind] || 'Destination';
      setText(el, '.kind', mid.length ? `${mid.length} stop${mid.length > 1 ? 's' : ''} → ${finalKind}` : finalKind);
      const key = mid.map(x => x.id + x.n).join();
      if (el.dataset.stops !== key) {
        el.dataset.stops = key;
        el.querySelector('.tripStops').innerHTML = mid.map(x => `<span class="stopChip"><i>${x.n}</i>${esc(x.name)}</span>`).join('');
      }
      setText(el, '.tripDest', (mid.length ? '⚑ ' : '') + route.destination.name);
      // how much of the trip is behind you (0 → 100 %)
      const pl = el.querySelector('.progLine');
      pl.hidden = !(on && s.nav.progress != null);
      if (!pl.hidden) { pl.querySelector('i').style.width = (s.nav.progress * 100).toFixed(1) + '%'; setText(pl, '.pct', Math.floor(s.nav.progress * 100) + '%'); }
      if (!on) return;
      setText(el, '.eta', fmtDur(s.nav.eta));
      setText(el, '.dist', fmtDist(s.nav.remaining));
      const now = s.ch?.['game.time'];
      setText(el, '.arr', typeof now === 'number' ? '· arr ' + hereTime(s, now + s.nav.eta / 60).slice(4) + (s.clockTz ? ' ' + s.clockTz.abbr : '') : '');
    },
  },
  restplan: {
    name: 'Rest plan', group: 'Delivery', icon: 'bed', zones: CARD_ZONES, cls: () => 'card restplan',
    html: () => `<div class="cardHead">${icon('bed')}<span class="grow">Rest plan</span></div><div class="cardBody"><b>–</b><span>–</span></div>`,
    update(el, s) {
      const p = s.restPlan;
      tog(el, 'empty', !p);
      tog(el, 'required', p?.type === 'required');
      if (!p) { setText(el, 'b', ''); setText(el, '.cardBody span', 'No rest stop needed on this route'); return; }
      const verb = { required: 'Rest at', spare: 'Optional rest at', wait: 'Wait at' }[p.type] || 'Stop at';
      setText(el, 'b', `${verb} ${p.name} · in ${fmtDur(p.etaMin * 60)}`);
      setText(el, '.cardBody span', p.detail);
    },
  },
  delivery: {
    // One card for the whole delivery, read top to bottom:
    //   what & pay → where → are we on time (status) → timeline → arrive / window / deadline → why (breakdown) → cargo damage
    name: 'Delivery', group: 'Delivery', icon: 'box', zones: CARD_ZONES, cls: () => 'card tap deliveryCard',
    html: () => `<div class="dvHead">${icon('box')}<div class="dvWhat"><b class="cargo">–</b><span class="mass"></span></div><b class="pay"></b></div>
      <div class="dvRoute"><span class="from">–</span><i>→</i><span class="to">–</span></div>
      <div class="progLine job"><div class="pbar"><i></i></div><b class="pct"></b><span class="pleft"></span></div>
      <div class="dvStatus"><span class="dot"></span><b class="stTitle">–</b><span class="stSub"></span></div>
      <div class="dvLine"><div class="dvBar"><i class="early"></i><i class="win"></i><i class="late"></i><span class="mk eta"></span><span class="mk dl"></span></div>
        <div class="dvTicks"><span class="tNow">now</span><span class="tEta"></span><span class="tDue"></span></div></div>
      <div class="dvGrid">
        <div><span class="k">Arrive</span><b class="arr">–</b><small class="arrIn"></small></div>
        <div class="winCell"><span class="k">Window</span><b class="winTxt">–</b><small class="winSet">tap to set start</small></div>
        <div><span class="k">Deadline</span><b class="due">–</b><small class="left"></small></div>
      </div>
      <div class="dvWhy"></div>
      <div class="dvCargo"><span class="k">Cargo damage</span><div class="cbar"><i></i></div><b class="cdmg">–</b></div>`,
    init(el) {
      el.querySelector('.winCell').addEventListener('click', e => { if (editing || !last?.job) return; e.stopPropagation(); $('btnSetEarliest').click(); });
    },
    tap: () => openSheet('jobSheet'),
    update(el, s) {
      const j = s.job, t = s.timing, plan = s.plan;
      tog(el, 'empty', !j);
      if (!j) {
        setText(el, '.cargo', 'No delivery'); setText(el, '.pay', ''); setText(el, '.mass', '');
        setText(el, '.from', 'Take a job in the game –'); setText(el, '.to', 'the route is set automatically');
        return;
      }
      const place = x => { const [company, city] = String(x || '').split(', '); return city ? `${city} · ${company}` : company; };
      setText(el, '.cargo', j.cargo || 'Delivery');
      setText(el, '.mass', j.cargoMass ? `${(j.cargoMass / 1000).toFixed(1)} t` : '');
      setText(el, '.pay', money(j.income));
      setText(el, '.from', place(j.from));
      setText(el, '.to', place(j.to));
      // the whole delivery: share of the job's planned distance already driven
      const jp = s.jobProgress, pl = el.querySelector('.progLine');
      pl.hidden = !jp;
      if (jp) {
        pl.querySelector('i').style.width = (jp.value * 100).toFixed(1) + '%';
        setText(pl, '.pct', Math.floor(jp.value * 100) + '%');
        setText(pl, '.pleft', `${fmtDist(jp.leftM)} to go`);
      }

      // status: the one thing to know first
      let state = 'none', title = 'No route yet', sub = 'Set a route to see your arrival time';
      if (t && t.eta != null) {
        if (t.early != null) { state = 'early'; title = `Too early by ${fmtDurShort(t.early * 60)}`; sub = `window opens ${destTime(t, t.earliest)}, rest or wait on the way`; }
        else if (t.spare != null && t.spare < 0) { state = 'late'; title = `Late by ${fmtDurShort(-t.spare * 60)}`; sub = 'drive on, skip optional stops'; }
        else { state = 'ok'; title = 'On time'; sub = `${fmtDurShort((t.spare ?? 0) * 60)} to spare`; }
      } else if (t && t.dueIn < 0) { state = 'late'; title = 'Overdue'; sub = ''; }
      el.dataset.state = state;
      setText(el, '.stTitle', title); setText(el, '.stSub', sub);

      // timeline: now → deadline (or arrival if later); window band, arrival marker
      const span = t ? Math.max(t.dueIn, t.eta ?? 0, 1) * 1.08 : 1;
      const pct = m => `${Math.max(0, Math.min(100, (m / span) * 100)).toFixed(1)}%`;
      if (t) {
        const ws = t.earliest != null ? Math.max(0, t.earliest - t.now) : 0;
        const bar = el.querySelector('.dvBar');
        bar.querySelector('.early').style.width = pct(ws);
        bar.querySelector('.win').style.left = pct(ws); bar.querySelector('.win').style.width = `calc(${pct(t.dueIn)} - ${pct(ws)})`;
        bar.querySelector('.late').style.left = pct(t.dueIn);
        bar.querySelector('.dl').style.left = pct(t.dueIn);
        const em = bar.querySelector('.eta');
        em.hidden = t.eta == null;
        if (t.eta != null) em.style.left = pct(t.eta);
        // stops along the way as small ticks
        const key = (plan?.stops || []).map(x => x.n + ':' + Math.round(x.arriveMin)).join();
        if (bar.dataset.k !== key) {
          bar.dataset.k = key;
          bar.querySelectorAll('.st').forEach(n => n.remove());
          for (const x of (plan?.stops || []).slice(0, -1)) bar.insertAdjacentHTML('beforeend', `<span class="st k-${x.kind}" style="left:${pct(x.arriveMin)}" title="${esc(x.name)}">${x.n}</span>`);
        }
        const te = el.querySelector('.tEta');
        te.textContent = t.eta != null ? 'arrive ' + destTime(t, t.now + t.eta) : '';
        // keep the arrival label on the bar and hide "now"/"deadline" when it would sit on top of them
        const ep = t.eta != null ? Math.max(0, Math.min(100, (t.eta / span) * 100)) : 50;
        te.style.left = Math.max(16, Math.min(84, ep)) + '%';
        el.querySelector('.tNow').hidden = ep < 34;
        el.querySelector('.tDue').hidden = ep > 66;
        setText(el, '.tDue', 'deadline');
      }

      // the three numbers
      setText(el, '.arr', t?.eta != null ? destTime(t, t.now + t.eta) : '–');
      setText(el, '.arrIn', t?.eta != null ? `in ${fmtDurShort(t.eta * 60)}${t.etaSource === 'game' ? ' · game GPS' : ''}` : 'no route');
      setText(el, '.winTxt', t ? `${t.earliest != null ? fmtClock(t.earliest + destShift(t)).slice(4) : '–'}–${destTime(t, t.due)}` : '–');
      // window start entered for this job, or a 5-hour guess (tap to enter the real one)
      tog(el.querySelector('.winSet'), 'hide', !!t && t.earliest != null && !t.earliestGuessed);
      setText(el, '.winSet', t?.earliestGuessed ? 'guess (5 h) · tap to set' : 'tap to set start');
      setText(el, '.due', t ? destTime(t, t.due, true) : '–');
      setText(el, '.left', t ? (t.dueIn >= 0 ? `${fmtDurShort(t.dueIn * 60)} left` : 'overdue') : '');

      // why: where the time goes
      const why = el.querySelector('.dvWhy');
      if (plan && t?.eta != null) {
        const icons = { fuel: '⛽', service: '🔧', rest: '🛏', point: '📍', favourite: '★' };
        const stays = plan.stops.filter(x => x.stayMin > 0).map(x => `${icons[x.kind] || '•'} ${fmtDurShort(x.stayMin * 60)}`);
        const parts = [`<span>🚗 drive ${fmtDurShort(plan.driveMin * 60)}</span>`];
        if (stays.length) parts.push(`<span>stops ${stays.join(' ')}</span>`);
        if (plan.lights + plan.signs) parts.push(`<span>🚦 ${plan.lights + plan.signs} lights/signs ≈ ${fmtDurShort(plan.waitMin * 60)}</span>`);
        why.innerHTML = parts.join('');
        why.hidden = false;
      } else why.hidden = true;

      // cargo damage
      const cd = j.cargoDamage;
      el.querySelector('.dvCargo').hidden = cd == null;
      if (cd != null) {
        setText(el, '.cdmg', `${cd.toFixed(cd < 10 ? 1 : 0)}%`);
        el.querySelector('.cbar i').style.width = Math.min(100, cd * 4) + '%';   // full bar at 25 %
        el.querySelector('.dvCargo').dataset.level = cd >= 10 ? 'bad' : cd >= 3 ? 'warn' : 'ok';
      }
    },
  },
  events: {
    name: 'Recent events', group: 'Delivery', icon: 'list', zones: CARD_ZONES, cls: () => 'card',
    html: () => `<div class="cardHead">${icon('list')}<span class="grow">Recent events</span></div><div class="evList muted">–</div>`,
    update(el, s) {
      const key = JSON.stringify(s.events || []);
      if (el.dataset.k === key) return;
      el.dataset.k = key;
      el.querySelector('.evList').innerHTML = eventsHtml(s.events) || 'Nothing yet';
    },
  },
  favs: {
    name: 'Favourites list', group: 'Stops', icon: 'star', zones: CARD_ZONES, cls: () => 'card',
    html: () => `<div class="cardHead">${icon('star')}<span class="grow">Favourites</span></div><div class="favRows"></div>`,
    init(el) { fillFavRows(el.querySelector('.favRows')); },
  },
  camera: {
    name: 'Rear camera', group: 'Camera', icon: 'camera', zones: CARD_ZONES, cls: () => 'card tap',
    html: () => `<div class="cardHead">${icon('camera')}<span class="grow">Rear camera</span></div><div class="camMini">Camera module coming, tap for parking cams</div>`,
    tap: () => openSheet('camSheet'),
  },
};

// Simple buttons that aren't game controls.
const BTN = {
  'stop:fuel': { name: 'Find fuel', label: 'Fuel', icon: 'fuel', group: 'Stops', cls: 'fuel', run: async () => { toast('Looking for fuel…'); const r = await api('POST', '/api/suggest', { kind: 'fuel' }); if (r?.error) toast(r.error); } },
  'stop:rest': { name: 'Find rest', label: 'Rest', icon: 'bed', group: 'Stops', cls: 'rest', run: async () => { toast('Looking for a rest area…'); const r = await api('POST', '/api/suggest', { kind: 'rest' }); if (r?.error) toast(r.error); } },
  'stop:service': { name: 'Find mechanic', label: 'Mechanic', icon: 'wrench', group: 'Stops', cls: 'service', run: async () => { toast('Looking for a mechanic…'); const r = await api('POST', '/api/suggest', { kind: 'service' }); if (r?.error) toast(r.error); } },
  'btn:favs': { name: 'Favourites', label: 'Favourites', icon: 'star', group: 'Stops', cls: 'accent', run: () => openSheet('favSheet') },
  'btn:search': { name: 'Search', label: 'Search', icon: 'search', group: 'Navigation', run: () => toggleSearch() },
  'btn:endroute': { name: 'End route', label: 'End route', icon: 'flag', group: 'Navigation', on: () => !!route, run: () => route && api('DELETE', '/api/route') },
  'btn:job': { name: 'Delivery details', label: 'Delivery', icon: 'box', group: 'Delivery', run: () => openSheet('jobSheet') },
  'btn:camera': { name: 'Rear camera', label: 'Camera', icon: 'camera', group: 'Camera', run: () => openSheet('camSheet') },
  'btn:theme': { name: 'Day / night', label: 'Theme', icon: 'auto', group: 'Display', run: () => cycleTheme() },
  'btn:full': { name: 'Full screen', label: 'Full screen', icon: 'full', group: 'Display', run: () => toggleFullscreen() },
};

// Resolve any widget id (gauges/cards, plain buttons, ctl:<game action>) to one definition shape.
function widgetDef(id) {
  if (W[id]) return W[id];
  if (BTN[id]) {
    const b = BTN[id];
    return {
      name: b.name, group: b.group, icon: b.icon, zones: BTN_ZONES, cls: () => `btn cell ${b.cls || ''}`,
      html: () => `<span class="led"></span>${icon(id === 'btn:theme' ? themeIcon() : b.icon)}<span class="lbl">${esc(b.label)}</span>`,
      tap: () => b.run(),
      update: b.on || id === 'btn:theme' ? (el, s) => {
        if (b.on) tog(el, 'on', b.on(s));
        if (id === 'btn:theme') { const want = themeIcon(); if (el.dataset.ic !== want) { el.dataset.ic = want; el.querySelector('svg').outerHTML = icon(want); } }
      } : undefined,
    };
  }
  if (id.startsWith('ctl:')) {
    const mix = id.slice(4), c = CTL[mix];
    if (!c) return null;
    const special = () => SPECIAL_CONTROLS[mix];
    return {
      name: c.label, group: 'Car controls', icon: c.icon, zones: BTN_ZONES,
      cls: () => `btn cell${c.color ? ' c-' + c.color : ''}${c.blink ? ' blink' : ''}`,
      html: () => `<span class="led"${c.on || mix === 'lwinopen' || mix === 'rwinopen' ? '' : ' hidden'}></span>${icon(c.icon)}<span class="lbl">${esc(special()?.label() ?? c.label)}</span>${mix === 'wipers' ? '<span class="levels"><i></i><i></i><i></i></span>' : ''}`,
      tap: el => { if (special()) special().run(); else press(mix); setText(el, '.lbl', special()?.label() ?? c.label); },
      update(el, s) {
        const ch = s.ch || {};
        if (c.on) tog(el, 'on', c.on(ch));
        if (mix === 'wipers') el.querySelectorAll('.levels i').forEach((n, i) => tog(n, 'on', wiperLevel > i));
        if (mix === 'lwinopen') tog(el, 'on', winOpen.l);
        if (mix === 'rwinopen') tog(el, 'on', winOpen.r);
        if (special()) setText(el, '.lbl', special().label());
      },
    };
  }
  return null;
}
const ALL_WIDGETS = () => [...Object.keys(W), ...Object.keys(BTN), ...Object.keys(CTL).map(m => 'ctl:' + m)];

// ------------------------------------------------------------------ layout (per device + orientation)

function layoutKey() {
  const tablet = Math.min(screen.width, screen.height) >= 600;
  return `${tablet ? 'tablet' : 'phone'}-${innerWidth > innerHeight ? 'landscape' : 'portrait'}`;
}
function defaultLayout() {
  const dock = (settings?.buttons?.length ? settings.buttons : ['lblinker', 'light', 'hblight', 'wipers', 'flasher4way', 'parkingbrake', 'cruiectrl', 'engine', 'horn', 'rblinker'])
    .filter(m => CTL[m]).map(m => 'ctl:' + m);
  return {
    quick: ['stop:fuel', 'stop:rest', 'stop:service', 'btn:favs'],
    cluster: ['speed', 'revs', 'fuel', 'telltales'],
    side: ['delivery', 'trip', 'restplan'],
    dock,
  };
}
function currentLayout() {
  const L = settings?.layouts?.[layoutKey()];
  return L && ZONES.some(z => L[z]?.length) ? L : defaultLayout();
}

let mountedKey = '';
function mountLayout() {
  if (!settings) return;
  mountedKey = layoutKey();
  const L = currentLayout();
  document.body.classList.toggle('hideOffTelltales', !!settings.telltalesHideOff);
  for (const z of ZONES) {
    const zone = $('zone-' + z);
    zone.dataset.label = ZONE_LABEL[z];
    zone.innerHTML = '';
    for (const id of L[z] || []) {
      const def = widgetDef(id);
      if (def && def.zones.includes(z) && !zone.querySelector(`[data-id="${CSS.escape(id)}"]`)) zone.appendChild(createWidget(id, z));
    }
  }
  if (last) updateWidgets(last);
  if (typeof map !== 'undefined') setTimeout(() => map.resize(), 0);   // console size may have changed
}
function createWidget(id, zone) {
  const def = widgetDef(id);
  const el = document.createElement('div');
  el.className = 'w ' + def.cls(zone);
  el.dataset.id = id;
  el.innerHTML = def.html(zone) + '<span class="wx" title="Remove">✕</span>';
  def.init?.(el);
  el.addEventListener('click', e => {
    if (editing) { if (e.target.closest('.wx')) { el.remove(); refreshDrawer(); } return; }
    def.tap?.(el);
  });
  return el;
}
function updateWidgets(s) {
  for (const el of document.querySelectorAll('.zone > .w')) {
    if (el.classList.contains('placeholder')) continue;
    try { widgetDef(el.dataset.id)?.update?.(el, s); } catch (e) { console.warn('widget', el.dataset.id, e); }
  }
}
addEventListener('resize', () => { if (!editing && settings && layoutKey() !== mountedKey) mountLayout(); });

function toggleDamageDetail() {
  const d = last?.damage;
  toast(d ? 'Damage, ' + Object.entries(d.parts).map(([k, v]) => `${k} ${v}%`).join(' · ') : 'No damage data from the game yet');
}
function isSpeeding(ch) {
  const lim = ch['truck.navigation.speed.limit'];
  return !!(lim && settings?.speeding.enabled && fmtSpeed(ch['truck.speed'] ?? 0) > fmtSpeed(lim) + (settings.speeding.toleranceMph ?? 5) * (imperial() ? 1 : 1.609));
}
function eventsHtml(events) {
  const names = { 'job.delivered': 'Delivered', 'car_job.delivered': 'Delivered', 'job.cancelled': 'Job cancelled', 'car_job.cancelled': 'Job cancelled', 'player.fined': 'Fined', 'player.tollgate.paid': 'Toll paid', 'player.use.ferry': 'Ferry', 'player.use.train': 'Train' };
  return (events || []).slice().reverse().map(e => {
    const a = e.attr || {};
    const amount = a['revenue'] ?? a['fine.amount'] ?? a['pay.amount'];
    return `<div>${esc(names[e.id] || e.id)}${amount != null ? ' · ' + money(amount) : ''}${a['fine.offence'] ? ' · ' + esc(a['fine.offence']) : ''}</div>`;
  }).join('');
}

// ------------------------------------------------------------------ customize mode (drag & drop)

let editing = false;
function setEditing(on) {
  editing = on;
  document.body.classList.toggle('editing', on);
  $('editBar').hidden = !on;
  if (on) { closeSheets(); refreshDrawer(); }
  else { $('drawer').hidden = true; saveLayout(); }
  setTimeout(() => map.resize(), 0);
}
function layoutFromDom() {
  const L = {};
  for (const z of ZONES) L[z] = [...$('zone-' + z).children].filter(c => c.classList.contains('w') && !c.classList.contains('placeholder')).map(c => c.dataset.id);
  return L;
}
function saveLayout() {
  const L = layoutFromDom();
  settings.layouts = { ...(settings.layouts || {}), [layoutKey()]: L };
  api('PUT', '/api/settings', { layouts: { [layoutKey()]: L } }).then(s => { if (s) settings = s; });
}

// The "Add a widget" panel: every widget as a card with a live preview (the real widget, scaled down)
// and the places it can go. Picking a card lights up those places on the screen; tapping a place adds
// it there (or drag the card onto the screen). The panel stays clear of the dock at the bottom.
const ZONE_SHORT = { dock: 'Dock', side: 'Side panel', cluster: 'Instruments', quick: 'Map' };
const ZONE_PREF = ['dock', 'side', 'cluster', 'quick'];
let drawerPick = null;
function markZones(def) {
  for (const z of ZONES) { const zn = $('zone-' + z); tog(zn, 'accept', !!def && def.zones.includes(z)); tog(zn, 'deny', !!def && !def.zones.includes(z)); }
}
function placeDrawer() {
  document.documentElement.style.setProperty('--dockH', ($('zone-dock')?.offsetHeight ?? 80) + 'px');
}
function refreshDrawer() {
  if (!editing) return;
  placeDrawer();
  const used = new Set(Object.values(layoutFromDom()).flat());
  const groups = {};
  for (const id of ALL_WIDGETS()) { const d = widgetDef(id); if (d) (groups[d.group] ??= []).push([id, d]); }
  const order = ['Instruments', 'Navigation', 'Stops', 'Delivery', 'Car controls', 'Camera', 'Display'];
  const zonesOf = d => ZONE_PREF.filter(z => d.zones.includes(z));
  $('drawerList').innerHTML = order.filter(g => groups[g]).map(g => `<h4>${g}</h4><div class="wcards">${groups[g].map(([id, d]) =>
    `<div class="wcard${used.has(id) ? ' used' : ''}${drawerPick === id ? ' pick' : ''}" data-add="${id}">
      <div class="wprev"></div>
      <div class="wmeta"><b>${esc(d.name)}${used.has(id) ? ' <small>on screen</small>' : ''}</b>
        <span class="wto">${zonesOf(d).map(z => `<button type="button" data-to="${z}">＋ ${ZONE_SHORT[z]}</button>`).join('')}</span></div>
    </div>`).join('')}</div>`).join('');
  // live previews: the real widget as it looks in its first place, scaled to fit the card
  for (const card of $('drawerList').querySelectorAll('.wcard')) {
    const id = card.dataset.add, d = widgetDef(id), z = zonesOf(d)[0];
    const el = createWidget(id, z);
    el.classList.add('inPreview', 'in-' + z);
    card.querySelector('.wprev').appendChild(el);
    try { if (last) d.update?.(el, last); } catch { /* no data yet */ }
    requestAnimationFrame(() => {
      const box = card.querySelector('.wprev'), w = el.offsetWidth || 1, h = el.offsetHeight || 1;
      el.style.transform = `translate(-50%, -50%) scale(${Math.min(1, (box.clientWidth - 8) / w, (box.clientHeight - 8) / h).toFixed(3)})`;
    });
  }
  markZones(drawerPick ? widgetDef(drawerPick) : null);
}
// closing the panel (✕, or "＋ Add" again) or leaving Customize: nothing picked, no lit-up places
const unpick = () => { drawerPick = null; markZones(null); };
document.querySelector('#drawer [data-close]')?.addEventListener('click', unpick);
document.getElementById('editAdd')?.addEventListener('click', () => setTimeout(() => { if ($('drawer').hidden) unpick(); }, 0));
document.getElementById('editDone')?.addEventListener('click', unpick);
function addWidgetTo(id, z) {
  const el = createWidget(id, z);
  $('zone-' + z).appendChild(el);
  if (last) updateWidgets(last);
  el.classList.add('justAdded');
  setTimeout(() => el.classList.remove('justAdded'), 1800);
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  drawerPick = null;
  refreshDrawer();
  toast(`${widgetDef(id).name} added to ${ZONE_SHORT[z]}. Drag it to move it.`);
  setTimeout(() => map.resize(), 0);
}

// Drag: pointerdown on a widget (edit mode) or on a drawer chip starts it. A placeholder copy of
// the widget moves through the zones to show where it will land; zones that can't hold the widget
// are dimmed. Dropping outside every zone puts a moved widget back where it was.
let drag = null;
function beginDrag(e, id, srcEl) {
  const def = widgetDef(id);
  if (!def) return;
  const rect = (srcEl || e.target).getBoundingClientRect();
  const ghost = srcEl ? srcEl.cloneNode(true) : createWidget(id, def.zones[0]);
  ghost.classList.add('dragGhost');
  ghost.style.width = rect.width + 'px';
  if (!srcEl) ghost.style.background = 'var(--tile)';
  document.body.appendChild(ghost);
  const offX = srcEl ? e.clientX - rect.left : 30, offY = srcEl ? e.clientY - rect.top : 30;
  const ph = srcEl || createWidget(id, def.zones[0]);
  ph.classList.add('placeholder');
  drag = { id, def, ghost, ph, offX, offY, origin: srcEl ? { parent: srcEl.parentNode, next: srcEl.nextSibling } : null, placed: !!srcEl, drawerWasOpen: !$('drawer').hidden };
  $('drawer').hidden = true;
  for (const z of ZONES) { const zn = $('zone-' + z); tog(zn, 'accept', def.zones.includes(z)); tog(zn, 'deny', !def.zones.includes(z)); }
  moveDrag(e);
  addEventListener('pointermove', moveDrag);
  addEventListener('pointerup', endDrag, { once: true });
  addEventListener('pointercancel', endDrag, { once: true });
}
function moveDrag(e) {
  if (!drag) return;
  drag.ghost.style.left = e.clientX - drag.offX + 'px';
  drag.ghost.style.top = e.clientY - drag.offY + 'px';
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const zone = under?.closest('.zone');
  if (!zone || !drag.def.zones.includes(zone.dataset.zone)) return;
  const zName = zone.dataset.zone;
  // widgets look different per zone (e.g. round on the map) → re-create the placeholder for it
  if (drag.ph.parentNode !== zone && drag.ph.parentNode?.dataset.zone !== zName) {
    const fresh = createWidget(drag.id, zName);
    fresh.classList.add('placeholder');
    drag.ph.remove();
    drag.ph = fresh;
  }
  const vertical = zName === 'quick';
  const kids = [...zone.children].filter(c => c !== drag.ph && c.classList.contains('w'));
  const before = kids.find(c => {
    const r = c.getBoundingClientRect();
    return vertical ? e.clientY < r.top + r.height / 2 : e.clientY < r.top || (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2);
  });
  if (drag.ph.parentNode !== zone || drag.ph.nextSibling !== (before ?? null)) zone.insertBefore(drag.ph, before ?? null);
  drag.placed = true;
}
function endDrag() {
  if (!drag) return;
  removeEventListener('pointermove', moveDrag);
  drag.ghost.remove();
  if (!drag.ph.parentNode?.classList?.contains('zone')) {
    // dropped nowhere: a moved widget goes back, a new one is discarded
    if (drag.origin) drag.origin.parent.insertBefore(drag.ph, drag.origin.next);
  }
  drag.ph.classList.remove('placeholder');
  for (const z of ZONES) $('zone-' + z).classList.remove('accept', 'deny');
  const reopen = drag.drawerWasOpen;
  drag = null;
  if (last) updateWidgets(last);
  refreshDrawer();
  if (reopen) $('drawer').hidden = false;
  setTimeout(() => map.resize(), 0);
}

// Pointer handling for edit mode: widgets drag immediately; drawer chips drag after a small move,
// or add themselves to their first allowed zone on a plain tap.
document.addEventListener('pointerdown', e => {
  if (!editing || drag) return;
  if (e.target.closest('.wx')) return;
  // a widget is picked in the panel: tapping one of its lit-up places adds it there
  const zoneHit = drawerPick && !e.target.closest('#drawer') ? e.target.closest('.zone.accept') : null;
  if (zoneHit) { e.preventDefault(); addWidgetTo(drawerPick, zoneHit.dataset.zone); return; }
  const w = e.target.closest('.zone > .w');
  if (w) { e.preventDefault(); beginDrag(e, w.dataset.id, w); return; }
  const card = e.target.closest('.wcard[data-add]');
  if (!card) return;
  const id = card.dataset.add;
  const to = e.target.closest('[data-to]');
  if (to) { e.preventDefault(); addWidgetTo(id, to.dataset.to); return; }
  e.preventDefault();
  const x0 = e.clientX, y0 = e.clientY;
  const mv = ev => { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 10) { cleanup(); drawerPick = null; beginDrag(ev, id, null); } };
  const up = () => {
    cleanup();
    // a tap selects the card: its places light up on the screen, its "+ Dock / + Side panel…" buttons show
    drawerPick = drawerPick === id ? null : id;
    for (const c of $('drawerList').querySelectorAll('.wcard')) c.classList.toggle('pick', c.dataset.add === drawerPick);
    markZones(drawerPick ? widgetDef(drawerPick) : null);
  };
  const cleanup = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
  addEventListener('pointermove', mv);
  addEventListener('pointerup', up);
}, true);
