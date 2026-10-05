// Fake DashLink plugin for testing without the game: serves ws://127.0.0.1:25555/ws with a car
// driving slowly near Bakersfield, 20 % fuel and a Road Trip job to a company in Fresno.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const dir = path.join(os.homedir(), 'Documents', 'ATS_Dashboard', 'mapdata', 'parser');
const cities = JSON.parse(fs.readFileSync(path.join(dir, 'usa-cities.json'), 'utf8'));
const companies = JSON.parse(fs.readFileSync(path.join(dir, 'usa-companies.json'), 'utf8'));
const start = cities.find((c: { token: string }) => c.token === 'bakersfield');
const dest = companies.find((c: { cityToken: string }) => c.cityToken === 'fresno');
console.log('start', start.name, start.x, start.y, '→ job to', dest.token, '@', dest.cityToken);

let x = start.x, z = start.y, heading = 0.0;
const wss = new WebSocketServer({ port: 25555, path: '/ws' });
wss.on('connection', ws => {
  console.log('dashlink server connected');
  const t = setInterval(() => {
    // Stand still: drifting in a straight line leaves the road and triggers constant rerouting.
    ws.send(JSON.stringify({
      game: 'ats 1.61 (simulated)',
      paused: false,
      ch: {
        'truck.world.placement': { pos: [x, 10, z], rot: [heading, 0, 0] },
        'truck.speed': 0, 'truck.engine.rpm': 750, 'truck.displayed.gear': 0,
        'truck.fuel.amount': 14, 'truck.fuel.range': 180, 'rest.stop': 300, 'game.time': 600,
        'truck.navigation.speed.limit': 24.6, 'truck.engine.enabled': true, 'truck.light.beam.low': true,
      },
      cfg: {
        truck: { 'fuel.capacity': 70, brand: 'ford', name: 'Crown Victoria' },
        car_job: { cargo: 'Parcels', 'destination.company.id': dest.token, 'destination.city.id': dest.cityToken, 'destination.city': 'Fresno', 'source.city': 'Bakersfield', income: 1250, 'planned_distance.km': 180, 'delivery.time': 600 + 20 * 60 },
      },
      events: [],
    }));
  }, 100);
  ws.on('message', m => console.log('button press from dashboard:', String(m)));
  ws.on('close', () => clearInterval(t));
});
console.log('simulated plugin on ws://127.0.0.1:25555/ws');
