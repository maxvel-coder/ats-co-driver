// Bundles and runs the website scene extractor (build/site-scenes/extract.ts). See that file for usage.
//   node build/site-scenes.mjs explore --from bakersfield --to fresno
//   node build/site-scenes.mjs build [--only hero,junction]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const REL = path.resolve(import.meta.dirname, '..');
const DEPS = process.env.CODRIVER_DEPS ?? path.join(process.env.USERPROFILE, 'Documents', 'ATS_Dashboard', 'maps-main');
const esbuild = createRequire(path.join(DEPS, 'package.json'))('esbuild');
const out = path.join(REL, 'build', 'out', 'site-scenes.mjs');
await esbuild.build({
  entryPoints: [path.join(REL, 'build/site-scenes/extract.ts')], outfile: out,
  bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning',
  alias: Object.fromEntries(['base', 'io', 'map', 'ui'].map(n => [`@truckermudgeon/${n}`, path.join(REL, 'src/packages/libs', n)])),
  nodePaths: [path.join(DEPS, 'node_modules')],
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);" },
  define: { 'import.meta.dirname': JSON.stringify(path.join(REL, 'build', 'site-scenes')) },
});
spawn(process.execPath, ['--max-old-space-size=8192', out, ...process.argv.slice(2)], { stdio: 'inherit' }).on('exit', c => process.exit(c ?? 0));
