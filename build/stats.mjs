// How many times each release's installer was downloaded (GitHub counts it; no setup needed).
//   node build/stats.mjs <github-user>/<repo>
const repo = process.argv[2];
if (!repo) { console.log('usage: node build/stats.mjs <github-user>/<repo>'); process.exit(1); }
const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers: { 'User-Agent': 'ats-co-driver-stats' } });
if (!res.ok) { console.log(`GitHub answered ${res.status}: ${await res.text()}`); process.exit(1); }
let total = 0;
for (const r of await res.json()) {
  for (const a of r.assets) { total += a.download_count; console.log(`${r.tag_name.padEnd(10)} ${a.name.padEnd(36)} ${String(a.download_count).padStart(7)} downloads`); }
}
console.log(`${''.padEnd(47)} ${String(total).padStart(7)} in total`);
