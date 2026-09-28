import { hash3, sfc32, weighted } from '../core/rng';

export type WeatherKind = 'clear' | 'overcast' | 'rain' | 'fog' | 'storm';
export const WEATHER_KINDS: readonly WeatherKind[] = ['clear', 'overcast', 'rain', 'fog', 'storm'];

/** Time of day and weather at one moment. Every value is 0..1 unless noted. */
export interface Env {
  /** 0..24 */
  hour: number;
  /** Sun up = 1, night = 0 (smooth through dawn and dusk). */
  daylight: number;
  darkness: number;
  /** Cloud cover (dims the sun, greys the sky). */
  cloud: number;
  rain: number;
  fog: number;
  /** Thunderstorm strength (lightning). */
  storm: number;
  /** The weather the current window is turning into. */
  weather: WeatherKind;
}

export interface EnvOverride {
  /** Fixed hour (0..24), or undefined for the cycle. */
  hour?: number;
  /** Fixed weather, or undefined for the seeded forecast. */
  weather?: WeatherKind;
}

/** One full day in real seconds: 24 minutes, so a game hour lasts a minute. */
export const DAY_LENGTH = 24 * 60;
/** New games start at sunrise, in the golden light (full day a few minutes later). */
export const START_HOUR = 6.5;
/** Weather changes every 4 minutes and blends in over the first 30 s. */
export const WEATHER_WINDOW = 240;
const WEATHER_BLEND = 30;

/** Dawn 5-7, day 7-20, dusk 20-22, night 22-5 (13 min of day, 7 of night). */
const DAWN = [5, 7] as const;
const DUSK = [20, 22] as const;

const WEATHER_ODDS: readonly (readonly [WeatherKind, number])[] = [
  ['clear', 55],
  ['overcast', 15],
  ['rain', 15],
  ['fog', 10],
  ['storm', 5],
];

const LOOK: Record<WeatherKind, { cloud: number; rain: number; fog: number; storm: number }> = {
  clear: { cloud: 0, rain: 0, fog: 0, storm: 0 },
  overcast: { cloud: 0.75, rain: 0, fog: 0.1, storm: 0 },
  rain: { cloud: 0.85, rain: 0.75, fog: 0.2, storm: 0 },
  fog: { cloud: 0.45, rain: 0, fog: 1, storm: 0 },
  storm: { cloud: 1, rain: 1, fog: 0.3, storm: 1 },
};

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export function hourAt(time: number): number {
  return (((START_HOUR + (time / DAY_LENGTH) * 24) % 24) + 24) % 24;
}

export function daylightAt(hour: number): number {
  if (hour >= DAWN[1] && hour <= DUSK[0]) return 1;
  if (hour > DAWN[0] && hour < DAWN[1]) return smooth((hour - DAWN[0]) / (DAWN[1] - DAWN[0]));
  if (hour > DUSK[0] && hour < DUSK[1]) return 1 - smooth((hour - DUSK[0]) / (DUSK[1] - DUSK[0]));
  return 0;
}

/** The seeded weather for a 4-minute slot; the first slot of a game is always clear. */
export function weatherFor(seed: number, window: number): WeatherKind {
  if (window <= 0) return 'clear';
  return weighted(sfc32(hash3(seed, window, 0x5eed, 97)), WEATHER_ODDS);
}

/** Time of day and weather at sim time `time` (deterministic in seed and time). */
export function envAt(seed: number, time: number, override: EnvOverride = {}, out?: Env): Env {
  const env = out ?? { hour: 0, daylight: 1, darkness: 0, cloud: 0, rain: 0, fog: 0, storm: 0, weather: 'clear' };
  env.hour = override.hour ?? hourAt(time);
  env.daylight = daylightAt(env.hour);
  env.darkness = 1 - env.daylight;
  let cur: WeatherKind;
  let k = 1;
  let prev: WeatherKind = 'clear';
  if (override.weather) {
    cur = override.weather;
  } else {
    const win = Math.floor(time / WEATHER_WINDOW);
    cur = weatherFor(seed, win);
    prev = weatherFor(seed, win - 1);
    k = smooth((time - win * WEATHER_WINDOW) / WEATHER_BLEND);
  }
  const a = LOOK[prev];
  const b = LOOK[cur];
  env.cloud = a.cloud + (b.cloud - a.cloud) * k;
  env.rain = a.rain + (b.rain - a.rain) * k;
  env.fog = a.fog + (b.fog - a.fog) * k;
  env.storm = a.storm + (b.storm - a.storm) * k;
  env.weather = cur;
  return env;
}

/** How well bots can see at this spot: 1 in daylight, down to 0.45 on a dark night, less in fog. */
export function visibilityAt(env: Env, lampDist: number, flashlight: boolean): number {
  if (flashlight && env.darkness > 0.3) return 1 - 0.35 * env.fog;
  // Street lamps light up about 6 m around them.
  const lit = lampDist < 6 ? 0.4 : 1;
  const dark = env.darkness * lit;
  return (1 - 0.55 * dark) * (1 - 0.35 * env.fog);
}
