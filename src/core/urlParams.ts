import type { WeatherKind } from '../sim/Environment';
import { fnv1a } from './rng';

export type WorldKind = 'city' | 'gym' | 'range';

export interface GameParams {
  seed: number;
  seedText: string;
  debug: boolean;
  world: WorldKind;
  noBots: boolean;
  god: boolean;
  /** Force a difficulty level for all encounters (-1 = by distance). */
  level: number;
  spawnCx: number;
  spawnCz: number;
  /** Simulation tick rate override. */
  tickRate: number;
  /** Fixed hour of day (0..24), or null for the day/night cycle. */
  hour: number | null;
  /** Fixed weather, or null for the seeded forecast. */
  weather: WeatherKind | null;
}

const WEATHERS: readonly WeatherKind[] = ['clear', 'overcast', 'rain', 'fog', 'storm'];

export function parseParams(search: string, randomSeed: number): GameParams {
  const q = new URLSearchParams(search);
  const seedRaw = q.get('seed');
  let seed = randomSeed >>> 0;
  let seedText = String(seed);
  if (seedRaw !== null && seedRaw !== '') {
    seedText = seedRaw;
    seed = /^\d+$/.test(seedRaw) ? Number(seedRaw) >>> 0 : fnv1a(seedRaw);
  }
  const worldRaw = q.get('world');
  const world: WorldKind = worldRaw === 'gym' || worldRaw === 'range' ? worldRaw : 'city';
  const flag = (k: string) => q.has(k) && q.get(k) !== '0' && q.get(k) !== 'false';
  const spawn = (q.get('spawn') ?? '').split(',').map((v) => Number.parseInt(v, 10));
  const tickRate = Number.parseInt(q.get('tick') ?? '', 10);
  const level = Number.parseInt(q.get('level') ?? '', 10);
  const hour = Number.parseFloat(q.get('time') ?? '');
  const weatherRaw = q.get('weather') as WeatherKind | null;
  return {
    seed,
    seedText,
    debug: flag('debug'),
    world,
    noBots: flag('nobots'),
    god: flag('god'),
    level: Number.isFinite(level) ? Math.max(0, Math.min(10, level)) : -1,
    spawnCx: Number.isFinite(spawn[0]) ? spawn[0] : 0,
    spawnCz: Number.isFinite(spawn[1]) ? spawn[1] : 0,
    tickRate: Number.isFinite(tickRate) && tickRate >= 8 && tickRate <= 256 ? tickRate : 64,
    hour: Number.isFinite(hour) ? ((hour % 24) + 24) % 24 : null,
    weather: weatherRaw && WEATHERS.includes(weatherRaw) ? weatherRaw : null,
  };
}
