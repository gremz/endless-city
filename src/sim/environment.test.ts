import { describe, expect, it } from 'vitest';
import { parseParams } from '../core/urlParams';
import { daylightAt, DAY_LENGTH, envAt, hourAt, visibilityAt, WEATHER_WINDOW, weatherFor } from './Environment';
import { nearestLampDist } from '../world/gen/streets';

describe('day/night cycle', () => {
  it('starts at sunrise and takes 24 minutes', () => {
    expect(hourAt(0)).toBe(6.5);
    expect(hourAt(DAY_LENGTH)).toBeCloseTo(6.5);
    expect(hourAt(60)).toBeCloseTo(7.5);
  });

  it('is bright by day, dark at night and smooth at dawn and dusk', () => {
    expect(daylightAt(12)).toBe(1);
    expect(daylightAt(1)).toBe(0);
    expect(daylightAt(6)).toBeGreaterThan(0);
    expect(daylightAt(6)).toBeLessThan(1);
    expect(daylightAt(21)).toBeGreaterThan(0);
    expect(daylightAt(21)).toBeLessThan(1);
    // 13 of the 24 minutes are full daylight, 7 full night.
    let day = 0;
    let night = 0;
    for (let h = 0; h < 24; h += 0.01) {
      if (daylightAt(h) === 1) day += 0.01;
      if (daylightAt(h) === 0) night += 0.01;
    }
    expect(day).toBeCloseTo(13, 0);
    expect(night).toBeCloseTo(7, 0);
  });
});

describe('weather', () => {
  it('is the same for the same seed and time, and starts clear', () => {
    expect(envAt(7, 1234)).toEqual(envAt(7, 1234));
    expect(envAt(7, 10).weather).toBe('clear');
    const kinds = new Set<string>();
    for (let w = 1; w < 400; w++) kinds.add(weatherFor(7, w));
    expect(kinds).toEqual(new Set(['clear', 'overcast', 'rain', 'fog', 'storm']));
  });

  it('blends into a new window instead of switching at once', () => {
    let seed = 1;
    // Find a seed whose second window is rain.
    while (weatherFor(seed, 1) !== 'rain') seed++;
    expect(envAt(seed, WEATHER_WINDOW - 1).rain).toBe(0);
    const mid = envAt(seed, WEATHER_WINDOW + 15).rain;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(0.75);
    expect(envAt(seed, WEATHER_WINDOW + 40).rain).toBeCloseTo(0.75);
  });

  it('can be fixed from the URL', () => {
    const p = parseParams('?time=23.5&weather=storm', 1);
    expect(p.hour).toBe(23.5);
    expect(p.weather).toBe('storm');
    const env = envAt(1, 0, { hour: p.hour!, weather: p.weather! });
    expect(env.darkness).toBe(1);
    expect(env.rain).toBe(1);
    expect(parseParams('?weather=snow', 1).weather).toBeNull();
  });
});

describe('visibility', () => {
  const night = envAt(1, 0, { hour: 1, weather: 'clear' });
  const noon = envAt(1, 0, { hour: 12, weather: 'clear' });

  it('drops at night, less under street lamps, and a flashlight gives you away', () => {
    expect(visibilityAt(noon, 50, false)).toBe(1);
    const dark = visibilityAt(night, 50, false);
    expect(dark).toBeLessThan(0.5);
    expect(visibilityAt(night, 3, false)).toBeGreaterThan(dark);
    expect(visibilityAt(night, 50, true)).toBe(1);
  });

  it('knows where the street lamps are', () => {
    expect(nearestLampDist(5, 5)).toBeCloseTo(0, 5);
    expect(nearestLampDist(64 + 32, 5)).toBeCloseTo(0, 5);
    expect(nearestLampDist(20, 30)).toBeGreaterThan(6);
  });
});
