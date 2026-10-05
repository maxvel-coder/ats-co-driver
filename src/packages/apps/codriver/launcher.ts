// ATS Co-Driver launcher, what the Start-menu shortcut runs.
//
// Every start:  find American Truck Simulator (Steam) → install / update the game plugin → build the
// map from the player's own game files when needed (first start, game update, new map DLC) →
// download the voice when missing → start the Co-Driver server → open the "connect your phone" page.
// Progress is shown on a setup page in the browser (http://localhost:8080) while this runs.
//
// Copyright (C) ATS Co-Driver contributors. GNU GPL v3 or later (see LICENSE).

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { findSteamAppSync } from 'steam-locate';

const VERSION = '1.0.3';
const PORT = Number(process.env.CODRIVER_PORT) || 8080;
const ATS_APP_ID = '270880';
// installed layout:  <install>\node\node.exe  +  <install>\app\{launcher,server}.mjs, tools\, native\, web\, maplibre\, plugin\, piper\
const PROGRAM_DIR = import.meta.dirname;
const NODE_EXE = process.execPath;
// (CODRIVER_HOME / CODRIVER_NO_PLUGIN / CODRIVER_NO_BROWSER are for testing a build next to a real install)
const HOME = process.env.CODRIVER_HOME ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ATS Co-Driver');
const MAP_DIR = path.join(HOME, 'map');
const LOG_DIR = path.join(HOME, 'logs');
const VOICE_DIR = path.join(HOME, 'voice');
const SETTINGS_FILE = path.join(HOME, 'launcher.json');   // remembered game folder (if picked by hand)
const PLUGIN_SRC = path.join(PROGRAM_DIR, 'plugin', 'ats_codriver.dll');
const VOICE = {
  name: 'en_US-amy-medium',
  // the official Piper voice library; downloaded on the player's PC, not shipped by us
  base: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/',
};
const NODE_MEMORY = ['--max-old-space-size=12288'];

for (const d of [HOME, MAP_DIR, LOG_DIR, VOICE_DIR]) fs.mkdirSync(d, { recursive: true });
const logFile = fs.createWriteStream(path.join(LOG_DIR, 'launcher.log'), { flags: 'w' });
function log(...a: unknown[]) {
  const line = `${new Date().toISOString().slice(11, 19)} ${a.map(String).join(' ')}`;
  console.log(line);
  logFile.write(line + '\n');
}

// ------------------------------------------------------------------ setup state shown on the page

type StepState = 'wait' | 'run' | 'ok' | 'skip' | 'warn' | 'fail';
interface Step { id: string; label: string; state: StepState; detail: string; progress?: number }
const steps: Step[] = [
  { id: 'game', label: 'Find American Truck Simulator', state: 'wait', detail: '' },
  { id: 'plugin', label: 'Install the game plugin', state: 'wait', detail: '' },
  { id: 'map', label: 'Build the map from your game', state: 'wait', detail: '' },
  { id: 'voice', label: 'Download the voice (Amy)', state: 'wait', detail: '' },
  { id: 'server', label: 'Start Co-Driver', state: 'wait', detail: '' },
];
const status = { version: VERSION, steps, error: '', done: false, needGameDir: false };
const step = (id: string) => steps.find(s => s.id === id)!;
function set(id: string, state: StepState, detail = '', progress?: number) {
  Object.assign(step(id), { state, detail, progress });
  if (state !== 'run') log(`[${id}] ${state} ${detail}`);
}

// ------------------------------------------------------------------ game folders

function readLauncherSettings(): { gameDir?: string } {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
const isAtsDir = (d?: string) => !!d && fs.existsSync(path.join(d, 'base_map.scs')) && fs.existsSync(path.join(d, 'bin', 'win_x64'));

function findGameDir(): string | null {
  const saved = readLauncherSettings().gameDir;
  if (isAtsDir(saved)) return saved!;
  try {
    const app = findSteamAppSync(ATS_APP_ID);
    if (app.isInstalled && isAtsDir(app.installDir)) return app.installDir!;
  } catch (e) { log('steam lookup:', e instanceof Error ? e.message : e); }
  for (const guess of ['C:\\Program Files (x86)\\Steam\\steamapps\\common\\American Truck Simulator', 'C:\\Program Files\\Steam\\steamapps\\common\\American Truck Simulator']) {
    if (isAtsDir(guess)) return guess;
  }
  return null;
}

// "Documents" may be redirected (OneDrive, another drive): ask Windows where it really is.
function documentsDir(): string {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Personal'], { encoding: 'utf8' });
    const m = out.match(/Personal\s+REG_\w+\s+(.+)/);
    if (m) return m[1].trim().replace(/%([^%]+)%/g, (_x, v: string) => process.env[v] ?? '');
  } catch { /* fall back */ }
  return path.join(os.homedir(), 'Documents');
}

// The game feeds the plugin's buttons into a control only if that control's binding in the profile
// lists "semantical.<name>". Rebinding a control in the game's options (or a wheel / gamepad preset)
// rewrites the line without it, and then that dashboard button does nothing. Put it back for the
// controls the plugin uses, in every profile, while the game is closed (it rewrites the file on exit).
const PLUGIN_MIXES = ['engine', 'engineelect', 'ignitionon', 'ignitionoff', 'ignitionstrt', 'light', 'lighton', 'lightoff', 'lightpark', 'hblight',
  'lblinker', 'rblinker', 'flasher4way', 'wipers', 'wipersback', 'wipers0', 'wipers1', 'wipers2', 'wipers3', 'wipers4',
  'cruiectrl', 'cruiectrlinc', 'cruiectrldec', 'cruiectrlres', 'parkingbrake', 'handbrake', 'horn', 'airhorn', 'beacon', 'cabinlight',
  'parking_cams', 'infotainment', 'navmap', 'cam1', 'cam2', 'cam3', 'cam4', 'cam5', 'cam6', 'camcycle', 'radiotoggle', 'radionext',
  'radioprev', 'screenshot', 'lwinopen', 'lwinclose', 'rwinopen', 'rwinclose', 'quickpark', 'showmirrors', 'activate', 'radioup', 'radiodown'];
const gameRunning = () => { try { return /amtrucks\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq amtrucks.exe', '/NH'], { encoding: 'utf8' })); } catch { return false; } };
function enableButtonsInProfiles(gameDocs: string): { fixed: number; profiles: number; skipped: string } {
  const files: string[] = [];
  for (const dir of ['profiles', 'steam_profiles']) {
    try { for (const p of fs.readdirSync(path.join(gameDocs, dir))) { const f = path.join(gameDocs, dir, p, 'controls.sii'); if (fs.existsSync(f)) files.push(f); } } catch { /* no such folder */ }
  }
  if (!files.length) return { fixed: 0, profiles: 0, skipped: '' };
  if (gameRunning()) return { fixed: 0, profiles: files.length, skipped: 'game running' };
  let fixed = 0, profiles = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    if (!text.startsWith('SiiNunit')) continue;   // not a plain-text file (another save format): leave it alone
    let n = 0;
    const out = text.replace(/("mix ([\w.]+) `)([^`]*)(`")/g, (m, head, name, expr, tail) => {
      if (!PLUGIN_MIXES.includes(name) || expr.includes(`semantical.${name}?`)) return m;
      n++;
      return `${head}${expr.trim() ? `${expr} | ` : ''}semantical.${name}?0${tail}`;
    });
    if (!n) continue;
    const bak = f + '.codriver-backup';
    if (!fs.existsSync(bak)) fs.copyFileSync(f, bak);   // the player's original, kept once
    fs.writeFileSync(f, out);
    fixed += n; profiles++;
    log(`controls: enabled ${n} dashboard buttons in ${f}`);
  }
  return { fixed, profiles, skipped: '' };
}

// ------------------------------------------------------------------ steps

// Every place the plugin was copied to, one per line, the uninstaller removes exactly these files.
const PLUGIN_LIST = path.join(HOME, 'plugin-paths.txt');
function rememberPlugin(dst: string) {
  let list: string[] = [];
  try { list = fs.readFileSync(PLUGIN_LIST, 'utf8').split(/\r?\n/).filter(Boolean); } catch { /* first time */ }
  if (!list.some(p => p.toLowerCase() === dst.toLowerCase())) fs.writeFileSync(PLUGIN_LIST, [...list, dst].join('\r\n') + '\r\n');
}

function installPlugin(gameDir: string) {
  set('plugin', 'run', 'Checking…');
  const dstDir = path.join(gameDir, 'bin', 'win_x64', 'plugins');
  const dst = path.join(dstDir, 'ats_codriver.dll');
  const hash = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  if (fs.existsSync(dst) && hash(dst) === hash(PLUGIN_SRC)) { rememberPlugin(dst); return set('plugin', 'ok', 'Already installed'); }
  try {
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(PLUGIN_SRC, dst);
    rememberPlugin(dst);
    return set('plugin', 'ok', 'Installed, the game asks once about "advanced SDK features": choose OK');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EBUSY') return set('plugin', 'warn', 'The game is running, close it and start Co-Driver again to update the plugin');
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      // Steam folder not writable for this user: copy once with administrator rights (Windows asks)
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-Command',
          `Start-Process -Verb RunAs -Wait -FilePath cmd.exe -ArgumentList '/c mkdir "${dstDir}" 2>nul & copy /y "${PLUGIN_SRC}" "${dst}"'`]);
        if (fs.existsSync(dst) && hash(dst) === hash(PLUGIN_SRC)) { rememberPlugin(dst); return set('plugin', 'ok', 'Installed (with administrator permission)'); }
      } catch { /* declined */ }
      return set('plugin', 'fail', `Couldn't copy the plugin. Copy "${PLUGIN_SRC}" into "${dstDir}" by hand.`);
    }
    return set('plugin', 'fail', String(err.message));
  }
}

// The map must be rebuilt when the game or its map DLCs change: fingerprint the map files.
function gameFingerprint(gameDir: string) {
  const files = fs.readdirSync(gameDir).filter(f => /^(base_map|base|def|version|core|locale)\.scs$|^dlc_.*\.scs$/.test(f)).sort();
  const h = crypto.createHash('sha256');
  for (const f of files) { const st = fs.statSync(path.join(gameDir, f)); h.update(`${f}|${st.size}|${st.mtimeMs}\n`); }
  return h.digest('hex').slice(0, 16);
}

function runNode(script: string, args: string[], label: string, onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(NODE_EXE, [...NODE_MEMORY, path.join(PROGRAM_DIR, 'tools', script), ...args], {
      env: { ...process.env, CODRIVER_NATIVE_DIR: path.join(PROGRAM_DIR, 'native'), FORCE_COLOR: '0', NO_COLOR: '1' },
      windowsHide: true,
    });
    const out = fs.createWriteStream(path.join(LOG_DIR, `map-${label}.log`));
    const feed = (d: Buffer) => { out.write(d); for (const l of d.toString('utf8').split(/\r|\n/)) if (l.trim()) onLine?.(l.trim()); };
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('exit', code => { out.end(); code === 0 ? resolve() : reject(Object.assign(new Error(`${label} failed (exit ${code})`), { label, code, logFile: path.join(LOG_DIR, `map-${label}.log`) })); });
  });
}

// A failed step in plain words, plus the details for a bug report (end of the tool's log, PC facts).
const PHASE_NAME: Record<string, string> = { parse: 'Reading the game files', graph: 'Building the road network', map: 'Drawing the map', icons: 'Cutting map icons' };
function explainFailure(e: unknown, gameDir: string) {
  const err = e as Error & { label?: string; code?: number; logFile?: string };
  let tail = '';
  try { tail = fs.readFileSync(err.logFile ?? '', 'utf8').split(/\r?\n/).filter(l => l.trim()).slice(-30).join('\n'); } catch { /* no log */ }
  const ram = Math.round(os.totalmem() / 2 ** 30), free = Math.round(os.freemem() / 2 ** 30);
  let reason: string;
  if (/heap out of memory|Allocation failed|ENOMEM/i.test(tail) || err.code === 134) reason = `Not enough memory (this PC has ${ram} GB, ${free} GB free). Close the game, browsers and other big programs, then press Try again.`;
  else if (/ENOSPC|no space left/i.test(tail)) reason = 'The disk is full. Free a few GB on the system drive, then press Try again.';
  else if (/EPERM|EACCES|EBUSY/i.test(tail)) reason = 'A file was locked or not allowed. Close the game, then press Try again.';
  else {
    const line = tail.split('\n').reverse().find(l => /error|exception|cannot|failed|undefined/i.test(l)) ?? tail.split('\n').at(-1) ?? '';
    reason = `${PHASE_NAME[err.label ?? ''] ?? 'A step'} failed: ${line.trim().slice(0, 220) || err.message}`;
  }
  let dlcs: string[] = [];
  try { dlcs = fs.readdirSync(gameDir).filter(f => /^dlc_.*\.scs$/.test(f)); } catch { /* no folder */ }
  const report = [
    `**What happened:** ${PHASE_NAME[err.label ?? ''] ?? err.message} failed on the first start (${err.message}).`,
    '', `- Co-Driver ${VERSION}, Windows ${os.release()}, ${ram} GB RAM (${free} GB free)`,
    `- Map DLC files: ${dlcs.length} (${dlcs.map(f => f.replace(/^dlc_|\.scs$/g, '')).join(', ').slice(0, 400)})`,
    '', 'End of the log:', '```', tail.slice(-3500), '```',
  ].join('\n');
  return {
    reason,
    reportUrl: `https://github.com/maxvel-coder/ats-co-driver/issues/new?title=${encodeURIComponent(`First start: ${PHASE_NAME[err.label ?? ''] ?? 'setup'} failed`)}&body=${encodeURIComponent(report)}`,
  };
}

async function buildMap(gameDir: string) {
  const stampFile = path.join(MAP_DIR, 'stamp.json');
  const want = { fingerprint: gameFingerprint(gameDir), builder: VERSION };
  let have: typeof want | null = null;
  try { have = JSON.parse(fs.readFileSync(stampFile, 'utf8')); } catch { /* first start */ }
  const ready = have?.fingerprint === want.fingerprint && fs.existsSync(path.join(MAP_DIR, 'gen', 'usa-map.geojson')) && fs.existsSync(path.join(MAP_DIR, 'parser', 'usa-graph.json'));
  if (ready) return set('map', 'ok', 'Up to date');

  const parserDir = path.join(MAP_DIR, 'parser'), genDir = path.join(MAP_DIR, 'gen'), spriteDir = path.join(MAP_DIR, 'sprites');
  // phases already finished for this exact game version are not repeated (a failed or interrupted
  // build resumes where it stopped); a different game version starts from scratch
  const progressFile = path.join(MAP_DIR, 'progress.json');
  let finished: string[] = [];
  try { const p = JSON.parse(fs.readFileSync(progressFile, 'utf8')); if (p.fingerprint === want.fingerprint) finished = p.phases; } catch { /* none */ }
  if (!finished.length) for (const d of [parserDir, genDir, spriteDir]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
  const t0 = Date.now();
  const phases = [
    { label: 'parse', share: 0.55, text: 'Reading your game files (the longest part)', script: 'parser.mjs', args: ['-i', gameDir, '-o', parserDir] },
    { label: 'graph', share: 0.2, text: 'Building the road network', script: 'generator.mjs', args: ['graph', '-m', 'usa', '-i', parserDir, '-o', genDir] },
    { label: 'map', share: 0.17, text: 'Drawing the map', script: 'generator.mjs', args: ['map', '-m', 'usa', '-i', parserDir, '-o', genDir, '--type', 'geojson'] },   // plain GeoJSON: tiles are cut live by the server (no tippecanoe needed)
    { label: 'icons', share: 0.08, text: 'Cutting map icons', script: 'generator.mjs', args: ['spritesheet', '-m', 'usa', '-i', parserDir, '-o', spriteDir] },
  ];
  let done = 0;
  for (const ph of phases) {
    if (finished.includes(ph.label)) { done += ph.share; continue; }
    const startedAt = done;
    set('map', 'run', `${ph.text}…`, startedAt);
    // the tools print progress bars ("… 42% …"): use them to move the bar within this phase
    await runNode(ph.script, ph.args, ph.label, line => {
      const m = line.match(/(\d{1,3})%/);
      const pct = m ? Math.min(100, Number(m[1])) / 100 : null;
      const mins = ((Date.now() - t0) / 60000).toFixed(0);
      Object.assign(step('map'), { detail: `${ph.text}… (${mins} min so far, this happens only once)`, progress: pct != null ? startedAt + ph.share * pct : step('map').progress });
    });
    done += ph.share;
    if (ph.label === 'graph') fs.copyFileSync(path.join(genDir, 'usa-graph.json'), path.join(parserDir, 'usa-graph.json'));   // the server reads it next to the map data
    if (ph.label === 'map') fs.renameSync(path.join(genDir, 'ats.geojson'), path.join(genDir, 'usa-map.geojson'));            // the name the server loads
    finished.push(ph.label);
    fs.writeFileSync(progressFile, JSON.stringify({ fingerprint: want.fingerprint, phases: finished }));
  }
  fs.writeFileSync(stampFile, JSON.stringify(want));
  set('map', 'ok', `Built in ${((Date.now() - t0) / 60000).toFixed(1)} min`, 1);
}

async function download(url: string, to: string, onProgress: (p: number) => void) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const part = to + '.part';
  const out = fs.createWriteStream(part);
  let got = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    out.write(chunk);
    got += chunk.length;
    if (total) onProgress(got / total);
  }
  await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
  fs.renameSync(part, to);
}

async function getVoice() {
  const onnx = path.join(VOICE_DIR, VOICE.name + '.onnx'), json = onnx + '.json';
  if (fs.existsSync(onnx) && fs.existsSync(json)) return set('voice', 'ok', 'Amy is ready');
  try {
    set('voice', 'run', 'Downloading from the Piper voice library (60 MB)…', 0);
    await download(VOICE.base + VOICE.name + '.onnx.json', json, () => {});
    await download(VOICE.base + VOICE.name + '.onnx', onnx, p => Object.assign(step('voice'), { progress: p, detail: `Downloading from the Piper voice library, ${Math.round(p * 100)} %` }));
    set('voice', 'ok', 'Amy is ready', 1);
  } catch (e) {
    // no internet: everything else works; the Windows voice is used until the next start
    set('voice', 'warn', `Couldn't download (${e instanceof Error ? e.message : e}), the Windows voice is used for now`);
  }
}

// ------------------------------------------------------------------ setup page + server

let setupServer: http.Server | null = null;
function startSetupPage(): Promise<void> {
  const page = fs.readFileSync(path.join(PROGRAM_DIR, 'web', 'setup.html'));
  setupServer = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/setup/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(JSON.stringify(status));
    }
    if (u.pathname === '/setup/game-dir' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      const dir = String(JSON.parse(body || '{}').dir ?? '').trim().replace(/^"|"$/g, '');
      const ok = isAtsDir(dir);
      if (ok) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ gameDir: dir })); gameDirPicked?.(dir); }
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok }));
    }
    if (u.pathname === '/setup/retry' && req.method === 'POST') { retryRequested?.(); res.writeHead(200); return res.end('{}'); }
    if (u.pathname === '/setup/open-logs' && req.method === 'POST') {
      spawn('explorer.exe', [LOG_DIR], { detached: true, stdio: 'ignore' }).unref();
      res.writeHead(200); return res.end('{}');
    }
    if (u.pathname === '/icon.svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end(fs.readFileSync(path.join(PROGRAM_DIR, 'web', 'icon.svg'))); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(page);
  });
  return new Promise((resolve, reject) => {
    setupServer!.once('error', reject);
    setupServer!.listen(PORT, '127.0.0.1', () => resolve());
  });
}
let gameDirPicked: ((d: string) => void) | null = null;
let retryRequested: (() => void) | null = null;

function startServer(gameDocs: string): ChildProcess {
  set('server', 'run', 'Loading the map (about a minute)…');
  const out = fs.createWriteStream(path.join(LOG_DIR, 'server.log'));
  const p = spawn(NODE_EXE, [...NODE_MEMORY, path.join(PROGRAM_DIR, 'server.mjs')], {
    env: {
      ...process.env,
      CODRIVER_PROGRAM_DIR: PROGRAM_DIR,
      CODRIVER_HOME: HOME,
      CODRIVER_WEB_DIR: path.join(PROGRAM_DIR, 'web'),
      CODRIVER_MAPLIBRE_DIR: path.join(PROGRAM_DIR, 'maplibre'),
      CODRIVER_PIPER_EXE: path.join(PROGRAM_DIR, 'piper', 'piper.exe'),
      CODRIVER_GAME_DOCS: gameDocs,
      CODRIVER_PORT: String(PORT),
    },
    windowsHide: true,
  });
  const feed = (d: Buffer) => { out.write(d); process.stdout.write(d); if (/ready: open/.test(d.toString())) set('server', 'ok', 'Running'); };
  p.stdout!.on('data', feed);
  p.stderr!.on('data', feed);
  p.on('exit', code => { log(`Co-Driver server stopped (exit ${code})`); process.exit(code ?? 0); });
  return p;
}

const openBrowser = (url: string) => !process.env.CODRIVER_NO_BROWSER && spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();

async function alreadyRunning() {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/api/connect`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

// ------------------------------------------------------------------ main

async function main() {
  console.log(`\n  ATS Co-Driver ${VERSION}\n  Keep this window open while you play, closing it stops Co-Driver.\n`);
  if (await alreadyRunning()) { log('already running, opening the connect page'); openBrowser(`http://localhost:${PORT}/connect`); return; }
  await startSetupPage();
  openBrowser(`http://localhost:${PORT}/`);

  set('game', 'run', 'Looking for the game in Steam…');
  let gameDir = findGameDir();
  if (!gameDir) {
    status.needGameDir = true;
    set('game', 'warn', 'Not found automatically, enter the game folder on this page');
    gameDir = await new Promise<string>(r => { gameDirPicked = r; });
    status.needGameDir = false;
  }
  set('game', 'ok', gameDir);
  const gameDocs = path.join(documentsDir(), 'American Truck Simulator');

  if (process.env.CODRIVER_NO_PLUGIN) set('plugin', 'skip', 'Skipped (test run)');
  else {
    installPlugin(gameDir);
    try {
      const c = enableButtonsInProfiles(gameDocs);
      const s = step('plugin');
      if (c.skipped) s.detail += '. Close the game and start Co-Driver again once, so all dashboard buttons work';
      else if (c.fixed) s.detail += `. Dashboard buttons enabled for ${c.fixed} controls (${c.profiles} profile${c.profiles > 1 ? 's' : ''})`;
    } catch (e) { log('controls check failed:', e); }
  }
  // a failed map step waits on the page for "Try again" (it resumes from the failed step)
  for (;;) {
    try { await buildMap(gameDir); break; }
    catch (e) {
      const f = explainFailure(e, gameDir);
      log('map build failed:', e instanceof Error ? e.message : e);
      Object.assign(status, { error: f.reason, reportUrl: f.reportUrl });
      set('map', 'fail', f.reason);
      await new Promise<void>(r => { retryRequested = r; });
      retryRequested = null;
      Object.assign(status, { error: null, reportUrl: null });
    }
  }
  await getVoice();

  // hand the port over from the setup page to the real server (the page shows "loading" meanwhile)
  set('server', 'run', 'Loading the map (about a minute)…');
  await new Promise(r => setTimeout(r, 1800));   // let the page pick up this last state
  setupServer!.closeAllConnections();
  await new Promise<void>(r => setupServer!.close(() => r()));
  startServer(gameDocs);
}

process.on('uncaughtException', e => { status.error = String(e); log('ERROR', e); });
main().catch(e => { status.error = String(e); log('ERROR', e); });
