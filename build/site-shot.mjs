// Screenshots of a page at given moments (real time), with its console output — for checking the
// website's animated scenes. Uses headless Edge over the DevTools protocol.
//   node build/site-shot.mjs <url> <outPrefix> [width=1280] [height=800] [ms,ms,...=3000] [scale=1]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const [url, prefix, W = '1280', H = '800', times = '3000', scale = '1'] = process.argv.slice(2);
if (!url || !prefix) { console.log('usage: node build/site-shot.mjs <url> <outPrefix> [w] [h] [ms,ms,...] [scale]'); process.exit(1); }
const DEPS = process.env.CODRIVER_DEPS ?? path.join(process.env.USERPROFILE, 'Documents', 'ATS_Dashboard', 'maps-main');
const WebSocket = createRequire(path.join(DEPS, 'package.json'))('ws');
const edge = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
const port = 9333 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdshot-'));
const proc = spawn(edge, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--disable-gpu-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--hide-scrollbars', `--window-size=${W},${H}`, `--force-device-scale-factor=${scale}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not up yet */ }
}
if (!target) { console.error('Edge did not start'); proc.kill(); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.once('open', r));
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
ws.on('message', m => {
  const msg = JSON.parse(String(m));
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result ?? msg.error); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.consoleAPICalled') console.log(`[console.${msg.params.type}]`, msg.params.args.map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 400));
  if (msg.method === 'Runtime.exceptionThrown') { const d = msg.params.exceptionDetails; console.log('[exception]', (d.exception?.description ?? d.text).slice(0, 600)); }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') console.log('[log]', msg.params.entry.text.slice(0, 300));
});
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: +W, height: +H, deviceScaleFactor: +scale, mobile: false });
const t0 = Date.now();
await send('Page.navigate', { url });
// SHOT_PRE="ms|js ;; ms|js": run page JavaScript at given moments (e.g. open a menu) before the shots
const pre = (process.env.SHOT_PRE ?? '').split(';;').map(s => s.trim()).filter(Boolean).map(x => { const i = x.indexOf('|'); return { t: +x.slice(0, i), js: x.slice(i + 1) }; });
const steps = [...pre.map(p => ({ t: p.t, js: p.js })), ...times.split(',').map(t => ({ t: +t }))].sort((a, b) => a.t - b.t);
for (const st of steps) {
  const t = st.t;
  const wait = t - (Date.now() - t0);
  if (wait > 0) await sleep(wait);
  if (st.js) { const r = await send('Runtime.evaluate', { expression: st.js, awaitPromise: true }); if (r.exceptionDetails) console.log('[pre error]', r.exceptionDetails.text); continue; }
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const f = `${prefix}-${t}.png`;
  fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
  console.log(`shot ${f}`);
}
if (process.env.SHOT_EVAL) { const r = await send('Runtime.evaluate', { expression: process.env.SHOT_EVAL, returnByValue: true, awaitPromise: true }); console.log('[eval]', JSON.stringify(r.result?.value ?? r)); }
ws.close(); proc.kill();
await sleep(300);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
process.exit(0);
