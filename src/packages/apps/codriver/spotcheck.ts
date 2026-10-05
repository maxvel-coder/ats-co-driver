// Offline check for the "Enter" helper spots: loads the same map data as the server, converts prefab
// spawn / trigger points to world positions and measures how far each fuel / service spot lies from
// its service area's map icon (should be tens of metres, not kilometres).
// Usage (from maps-main): node node_modules/tsx/dist/cli.mjs packages/apps/dashlink/spotcheck.ts
import { fromDir } from '@truckermudgeon/io';
import { toMapPosition } from '@truckermudgeon/map/prefabs';
import os from 'node:os';
import path from 'node:path';
import { readGraphAndMapData } from '../../apis/navigation/infra/lookups/graph-and-map';

const MAP_DIR = path.join(os.homedir(), 'Documents', 'ATS_Dashboard', 'mapdata', 'parser');
const { tsMapData, graphData } = readGraphAndMapData(fromDir(MAP_DIR), 'usa');
const pts: { x: number; y: number; type: number }[] = [];
let withSpawns = 0;
for (const pf of tsMapData.prefabs.values()) {
  const desc = tsMapData.prefabDescriptions.get(pf.token) as any;
  if (!desc?.spawnPoints?.length) continue;
  withSpawns++;
  for (const s of desc.spawnPoints) if (s.type === 3 || s.type === 4) {
    const [x, y] = toMapPosition([s.x, s.y], pf, desc, tsMapData.nodes);
    pts.push({ x, y, type: s.type });
  }
}
console.log('prefabs with spawn points:', withSpawns, '— fuel/service spots:', pts.length);
const areas = [...graphData.serviceAreas.keys()].map(uid => tsMapData.nodes.get(uid)!).filter(Boolean);
const dists = pts.map(p => Math.min(...areas.map(a => Math.hypot(a.x - p.x, a.y - p.y)))).sort((a, b) => a - b);
const q = (f: number) => dists[Math.floor(dists.length * f)]?.toFixed(0);
console.log(`distance spot → nearest service-area icon (m): median ${q(0.5)}, 90% ${q(0.9)}, max ${dists.at(-1)?.toFixed(0)}`);
