// Bundles and runs the showcase driver (src/packages/apps/codriver/showcase.ts) — a fake game that
// drives along the Co-Driver route, for screenshots / videos / testing. Never run it next to the game.
//   node build/showcase.mjs [--server http://127.0.0.1:8080] [--from bakersfield] [--to fresno] [--speed 27] [--fuel 64]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const REL = path.resolve(import.meta.dirname, '..');
const DEPS = process.env.CODRIVER_DEPS ?? path.join(process.env.USERPROFILE, 'Documents', 'ATS_Dashboard', 'maps-main');
const esbuild = createRequire(path.join(DEPS, 'package.json'))('esbuild');
const out = path.join(REL, 'build', 'out', 'showcase.mjs');
await esbuild.build({
  entryPoints: [path.join(REL, 'src/packages/apps/codriver/showcase.ts')], outfile: out,
  bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning',
  alias: Object.fromEntries(['base', 'io', 'map', 'ui'].map(n => [`@truckermudgeon/${n}`, path.join(REL, 'src/packages/libs', n)])),
  nodePaths: [path.join(DEPS, 'node_modules')],
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);" },
});
spawn(process.execPath, [out, ...process.argv.slice(2)], { stdio: 'inherit' }).on('exit', c => process.exit(c ?? 0));
