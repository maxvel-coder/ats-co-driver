// Showcase / test driver: pretends to be the game plugin (ws://127.0.0.1:25555/ws) and drives a car
// along the route the Co-Driver server plans — for screenshots, videos and testing without the game.
// Refuses to start when the port is taken (e.g. the real game is running).
//
//   node build/showcase.mjs [--server http://127.0.0.1:8080] [--from bakersfield] [--to fresno] [--speed 27] [--fuel 64]
import { fromWgs84ToAtsCoords } from '@truckermudgeon/map/projections';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const arg = (n: string, d: string) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const SERVER = arg('server', 'http://127.0.0.1:8080');
const HOME = process.env.CODRIVER_HOME ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ATS Co-Driver');
const dir = path.join(HOME, 'map', 'parser');
const cities = JSON.parse(fs.readFileSync(path.join(dir, 'usa-cities.json'), 'utf8')) as { token: string; name: string; x: number; y: number }[];
const companies = JSON.parse(fs.readFileSync(path.join(dir, 'usa-companies.json'), 'utf8')) as { token: string; cityToken: string; x: number; y: number }[];
const start = cities.find(c => c.token === arg('from', 'bakersfield'))!;
const dest = companies.find(c => c.cityToken === arg('to', 'fresno'))!;
const CRUISE = Number(arg('speed', '27'));            // m/s on open road (~97 km/h)
const FUEL_PCT = Number(arg('fuel', '64'));

const portFree = (port: number) => new Promise<boolean>(r => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(port, '127.0.0.1'); });
if (!(await portFree(25555))) { console.error('Port 25555 is in use (is the game running?) — the showcase driver must not run next to the game.'); process.exit(1); }

let x = start.x, z = start.y, bearing = 0, speed = 0, odo = 0, gameTime = 6 * 1440 + 15 * 60 + 10;
let path2: [number, number][] = [], cum: number[] = [], along = 0, routeKey = '';
// follow the server's route: fetch it, convert to game coordinates, drive along it
async function refreshRoute() {
  try {
    const r = await (await fetch(SERVER + '/api/route')).json() as { line?: [number, number][]; destination?: { name: string } } | null;
    if (!r?.line?.length) return;
    const key = r.line.length + ':' + r.line[0].join() + ':' + r.line[r.line.length - 1].join();
    if (key === routeKey) return;
    routeKey = key;
    path2 = r.line.map(ll => fromWgs84ToAtsCoords(ll) as [number, number]);
    cum = [0];
    for (let i = 1; i < path2.length; i++) cum.push(cum[i - 1] + Math.hypot(path2[i][0] - path2[i - 1][0], path2[i][1] - path2[i - 1][1]));
    // continue from the point of the new route nearest to the car
    let bi = 0, bd = Infinity;
    for (let i = 0; i < path2.length; i++) { const d = Math.hypot(path2[i][0] - x, path2[i][1] - z); if (d < bd) { bd = d; bi = i; } }
    along = cum[bi];
    console.log(`route: ${(cum[cum.length - 1] / 1000).toFixed(1)} km (physical) to ${r.destination?.name}`);
  } catch { /* server not up yet */ }
}
setInterval(refreshRoute, 2000);

function pointAt(s: number) {
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const t = (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
  const a = path2[i - 1], b = path2[i];
  return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx: b[0] - a[0], dz: b[1] - a[1] };
}

const DT = 1 / 60;
setInterval(() => {
  if (cum.length < 2) return;
  const left = cum[cum.length - 1] - along;
  // look ahead for curves: slow down before sharp bends and at the end
  const here = pointAt(along), ahead = pointAt(Math.min(cum[cum.length - 1], along + 60));
  const turn = Math.abs(((Math.atan2(ahead.dx, -ahead.dz) - Math.atan2(here.dx, -here.dz)) * 180 / Math.PI + 540) % 360 - 180);
  const target = left < 40 ? 0 : Math.min(CRUISE, turn > 35 ? 9 : turn > 15 ? 16 : CRUISE, Math.max(4, left / 6));
  speed += Math.max(-4 * DT, Math.min(2.2 * DT, target - speed));
  along = Math.min(cum[cum.length - 1], along + speed * DT);
  odo += speed * DT;
  const p = pointAt(along);
  x = p.x; z = p.z;
  const b = (Math.atan2(p.dx, -p.dz) * 180 / Math.PI + 360) % 360;
  bearing = bearing + ((b - bearing + 540) % 360 - 180) * 0.15;
  gameTime += DT * 19 / 60;
}, 1000 * DT);

const wss = new WebSocketServer({ host: '127.0.0.1', port: 25555, path: '/ws' });
wss.on('connection', ws => {
  console.log('Co-Driver server connected');
  const t = setInterval(() => {
    const rpm = 800 + speed * 55, gear = speed < 0.3 ? 0 : Math.min(6, 1 + Math.floor(speed / 5));
    ws.send(JSON.stringify({
      game: 'ats (showcase driver)', paused: false,
      ch: {
        'truck.world.placement': { pos: [x, 10, z], rot: [1 - (((bearing % 360) + 360) % 360) / 360, 0, 0] },
        'truck.speed': speed, 'truck.engine.rpm': rpm, 'truck.displayed.gear': gear,
        'truck.fuel.amount': 70 * FUEL_PCT / 100 - odo / 9000, 'truck.fuel.range': 520 - odo / 1000 * 20, 'rest.stop': 400, 'game.time': gameTime,
        'truck.navigation.speed.limit': 29.06, 'truck.engine.enabled': true, 'truck.electric.enabled': true, 'truck.light.beam.low': true,
        'truck.cruise_control': speed > 20 ? CRUISE : 0, 'truck.wear.engine': 0.031, 'truck.wear.cabin': 0.046, 'truck.wear.chassis': 0.02,
        'job.cargo.damage': 0.012,
      },
      cfg: {
        truck: { 'fuel.capacity': 70, brand: 'ford', name: 'F-150', 'rpm.limit': 5800 },
        car_job: { cargo: 'Used cars', 'cargo.mass': 3400, 'destination.company.id': dest.token, 'destination.city.id': dest.cityToken, 'source.city': start.name, 'source.company': 'Showroom', income: 4820, 'planned_distance.km': 180, 'delivery.time': 6 * 1440 + 20 * 60 + 16 },
      },
      events: [],
    }));
  }, 16);
  ws.on('message', m => console.log('button press from dashboard:', String(m)));
  ws.on('close', () => clearInterval(t));
});
console.log(`showcase driver: ${start.name} → ${dest.token}@${dest.cityToken}, cruise ${CRUISE} m/s, plugin port 25555 (this PC only)`);
