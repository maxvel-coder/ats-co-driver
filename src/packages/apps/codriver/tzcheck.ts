// Offline check: projection scale (map metres per game metre) and the time zone of a few cities.
// Usage (from maps-main): node node_modules/tsx/dist/cli.mjs packages/apps/dashlink/tzcheck.ts
import { fromAtsCoordsToWgs84 } from '@truckermudgeon/map/projections';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), 'Documents', 'ATS_Dashboard', 'mapdata', 'parser');
const a = fromAtsCoordsToWgs84([0, 0]), b = fromAtsCoordsToWgs84([1000, 0]);
const k = Math.PI / 180, dLat = (b[1] - a[1]) * k, dLng = (b[0] - a[0]) * k * Math.cos(((a[1] + b[1]) / 2) * k);
console.log('map metres per game metre:', ((Math.sqrt(dLat * dLat + dLng * dLng) * 6371000) / 1000).toFixed(2));
const cities = JSON.parse(fs.readFileSync(path.join(DIR, 'usa-cities.json'), 'utf8')) as any[];
const countries = JSON.parse(fs.readFileSync(path.join(DIR, 'usa-countries.json'), 'utf8')) as any[];
for (const name of ['Lamar', 'Los Angeles', 'El Paso', 'Phoenix', 'Boise', 'Dallas']) {
  const c = cities.find(x => x.name === name);
  if (!c) { console.log(name, 'not found'); continue; }
  const st = countries.find(x => x.token === c.countryToken);
  let tz = st.timeZone;
  for (const s of st.secondaryTimeZones ?? []) if (c.x >= s.extent[0] && c.x <= s.extent[2] && c.y >= s.extent[1] && c.y <= s.extent[3]) tz = s.timeZone;
  console.log(`${name} (${st.code}): UTC${tz / 60} → game clock ${tz + 420 >= 0 ? '+' : ''}${(tz + 420) / 60} h`);
}
