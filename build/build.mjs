// Builds the installable ATS Co-Driver folder:  dist/ATS Co-Driver/
//
//   node/node.exe                    Node.js runtime (so users install nothing else)
//   app/launcher.mjs                 first-start setup + starts the server
//   app/server.mjs                   the Co-Driver server
//   app/tools/{parser,generator}.mjs map builder (runs once on the player's PC, from their own game)
//   app/native/*.node                native helpers the map reader needs
//   app/web/  app/maplibre/          the dashboard web app + map library
//   app/plugin/ats_codriver.dll      the game plugin (installed into ATS by the launcher)
//   app/piper/                       offline voice engine (the voice model is downloaded on first start)
//   ATS Co-Driver.cmd                portable start
//   LICENSE, THIRD-PARTY-NOTICES.txt
//
// Usage:  node build/build.mjs  [--deps <maps-main dir with node_modules>]
// Needs:  a maps-main checkout with `npm install` done (for esbuild and the bundled packages),
//         the built native addons (packages/clis/parser/build/Release/*.node), the plugin DLL in
//         build/out, a portable Node.js and Piper (paths below / arguments).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const REL = path.resolve(import.meta.dirname, '..');
const SRC = path.join(REL, 'src');
const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };
const DEPS = arg('deps', path.join(process.env.USERPROFILE, 'Documents', 'ATS_Dashboard', 'maps-main'));
const NODE_DIR = arg('node', path.join(process.env.USERPROFILE, 'Documents', 'ATS_Dashboard', 'tools', 'node-v24.21.0-win-x64'));
const PIPER_DIR = arg('piper', path.join(process.env.USERPROFILE, 'Documents', 'ATS_Dashboard', 'tools', 'piper', 'piper'));
const OUT = path.join(REL, 'dist', 'ATS Co-Driver');
const APP = path.join(OUT, 'app');

const require = createRequire(path.join(DEPS, 'package.json'));
const esbuild = require('esbuild');

const t0 = Date.now();
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(APP, 'tools'), { recursive: true });

// --- bundle the TypeScript entry points (workspace libs from this repo, third-party from DEPS)
const libs = Object.fromEntries(['base', 'io', 'map', 'ui'].map(n => [`@truckermudgeon/${n}`, path.join(SRC, 'packages', 'libs', n)]));
const common = {
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
  alias: libs,
  nodePaths: [path.join(DEPS, 'node_modules')],
  external: ['bufferutil', 'utf-8-validate', '*.node'],
  // CommonJS packages inside an ES module bundle need `require`
  banner: { js: "import { createRequire as __codriverRequire } from 'node:module'; const require = __codriverRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
  minify: false,
  sourcemap: false,
};
// each tool's own (nested, version-specific) node_modules first, then the shared ones
const nm = (...dirs) => [...dirs.map(d => path.join(DEPS, 'packages', d, 'node_modules')), path.join(DEPS, 'packages/libs/map/node_modules'), path.join(DEPS, 'node_modules')].filter(d => fs.existsSync(d));
const entries = [
  ['launcher', path.join(SRC, 'packages/apps/codriver/launcher.ts'), path.join(APP, 'launcher.mjs'), nm()],
  ['server', path.join(SRC, 'packages/apps/codriver/server.ts'), path.join(APP, 'server.mjs'), nm('apis/navigation')],
  ['parser', path.join(SRC, 'packages/clis/parser/index.ts'), path.join(APP, 'tools', 'parser.mjs'), nm('clis/parser')],
  ['generator', path.join(SRC, 'packages/clis/generator/index.ts'), path.join(APP, 'tools', 'generator.mjs'), nm('clis/generator')],
];
const bundledPackages = new Map();   // name -> dir, for the license notices
for (const [name, entry, outfile, nodePaths] of entries) {
  const r = await esbuild.build({ ...common, nodePaths, entryPoints: [entry], outfile });
  for (const input of Object.keys(r.metafile.inputs)) {
    const norm = input.replace(/\\/g, '/');
    const m = norm.match(/^(.*node_modules)\/((?:@[^/]+\/)?[^/]+)\//);
    if (m) bundledPackages.set(m[2], path.resolve(process.cwd(), m[1], m[2]));
  }
  console.log(`bundled ${name}: ${(fs.statSync(outfile).size / 1e6).toFixed(1)} MB`);
}

// --- files copied as they are
const copyDir = (from, to, filter = () => true) => fs.cpSync(from, to, { recursive: true, filter });
copyDir(path.join(SRC, 'packages/apps/codriver/web'), path.join(APP, 'web'), f => !/demo\.js$/.test(f) || true);
// the map builder's reference data (Natural Earth places, state shapes, small icons), next to tools/
copyDir(path.join(SRC, 'packages/clis/generator/resources'), path.join(APP, 'resources'));
fs.mkdirSync(path.join(APP, 'maplibre'));
for (const f of ['maplibre-gl.js', 'maplibre-gl.css']) fs.copyFileSync(path.join(DEPS, 'node_modules/maplibre-gl/dist', f), path.join(APP, 'maplibre', f));
fs.mkdirSync(path.join(APP, 'native'));
for (const f of ['cityhash.node', 'gdeflate.node']) fs.copyFileSync(path.join(DEPS, 'packages/clis/parser/build/Release', f), path.join(APP, 'native', f));
fs.mkdirSync(path.join(APP, 'plugin'));
fs.copyFileSync(path.join(REL, 'build/out/ats_codriver.dll'), path.join(APP, 'plugin', 'ats_codriver.dll'));
copyDir(PIPER_DIR, path.join(APP, 'piper'), f => !/libtashkeel_model\.ort$|pkgconfig/.test(f));   // tashkeel = Arabic diacritics, not needed
fs.mkdirSync(path.join(OUT, 'node'));
fs.copyFileSync(path.join(NODE_DIR, 'node.exe'), path.join(OUT, 'node', 'node.exe'));
fs.copyFileSync(path.join(NODE_DIR, 'LICENSE'), path.join(OUT, 'node', 'LICENSE'));
fs.copyFileSync(path.join(REL, 'build/icon/codriver.ico'), path.join(OUT, 'codriver.ico'));   // shortcuts / installer

fs.writeFileSync(path.join(OUT, 'ATS Co-Driver.cmd'), [
  '@echo off',
  'title ATS Co-Driver',
  'rem Starts ATS Co-Driver. Keep this window open while you play.',
  'cd /d "%~dp0"',
  '"%~dp0node\\node.exe" "%~dp0app\\launcher.mjs"',
  'if errorlevel 1 pause',
  '',
].join('\r\n'));

// --- licenses: GPL for Co-Driver itself, notices for everything bundled or shipped
fs.copyFileSync(path.join(SRC, 'LICENSE'), path.join(OUT, 'LICENSE.txt'));
const notices = [
  'ATS Co-Driver — third-party software notices',
  '=============================================',
  '',
  'ATS Co-Driver is free software under the GNU General Public License v3 or later (LICENSE.txt).',
  'Source code: see the project page. It builds on truckermudgeon/maps (GPL-3.0-or-later).',
  '',
  'Not affiliated with or endorsed by SCS Software. American Truck Simulator is a trademark of SCS Software.',
  'No game data is included: the map is built on your PC from your own copy of the game.',
  'The voice model (Piper "Amy") is downloaded on first start from the Piper voice library (rhasspy/piper-voices).',
  'app/resources: Natural Earth data (public domain, naturalearthdata.com) and files from truckermudgeon/maps.',
  '',
];
const licenseText = dir => {
  for (const f of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE', 'COPYING']) { const p = path.join(dir, f); if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim(); }
  return null;
};
const add = (name, version, license, text) => notices.push('-'.repeat(78), `${name}${version ? ' ' + version : ''} — ${license ?? 'see package'}`, '', text ?? '(license text not included in the package)', '');
add('Node.js', process.version, 'MIT and others', fs.readFileSync(path.join(NODE_DIR, 'LICENSE'), 'utf8').slice(0, 4000) + '\n[… full text in node/LICENSE]');
add('Piper (rhasspy/piper)', '2023.11.14-2', 'MIT', 'https://github.com/rhasspy/piper — MIT License');
add('MapLibre GL JS', require(path.join(DEPS, 'node_modules/maplibre-gl/package.json')).version, 'BSD-3-Clause', licenseText(path.join(DEPS, 'node_modules/maplibre-gl')));
for (const [name, dir] of [...bundledPackages].sort()) {
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* */ }
  add(name, pkg.version, typeof pkg.license === 'string' ? pkg.license : pkg.license?.type, licenseText(dir));
}
fs.writeFileSync(path.join(OUT, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n'));

const size = dir => fs.readdirSync(dir, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`\nbuilt ${OUT}\n  ${(size(OUT) / 1e6).toFixed(0)} MB, ${bundledPackages.size} bundled packages, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
