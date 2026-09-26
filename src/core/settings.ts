/** Player settings persisted to localStorage (versioned, merged with defaults). */
export interface Settings {
  sensitivity: number;
  zoomSensitivityRatio: number;
  /** CS-style horizontal FOV at 4:3. */
  fov: number;
  viewmodelFov: number;
  invertY: boolean;
  crosshairColor: string;
  crosshairSize: number;
  crosshairGap: number;
  crosshairThickness: number;
  crosshairDot: boolean;
  crosshairDynamic: boolean;
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  /** 0 = off, else shadow map size. */
  shadows: 0 | 1024 | 2048;
  renderScale: number;
  showFps: boolean;
  autoBhop: boolean;
  /** Day/night: follow the clock, or keep it day or night. */
  timeOfDay: 'cycle' | 'day' | 'night';
  /** Seeded weather, or always clear skies. */
  weather: 'dynamic' | 'clear';
  /** Rain streak amount (0 off, 0.5 low, 1 high). */
  rainParticles: number;
  /** Animated character models when available, or the simple box figures. */
  characters: 'detailed' | 'simple';
  /** Objective line, waypoint and one-time tips. */
  objectives: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 2,
  zoomSensitivityRatio: 1,
  fov: 90,
  viewmodelFov: 68,
  invertY: false,
  crosshairColor: '#4dff6a',
  crosshairSize: 6,
  crosshairGap: 3,
  crosshairThickness: 2,
  crosshairDot: false,
  crosshairDynamic: true,
  masterVolume: 0.7,
  sfxVolume: 1,
  musicVolume: 0.35,
  shadows: 2048,
  renderScale: 1,
  showFps: false,
  autoBhop: false,
  timeOfDay: 'cycle',
  weather: 'dynamic',
  rainParticles: 1,
  characters: 'detailed',
  objectives: true,
};

/** Allowed values for the settings that are really enums (stored as strings or numbers). */
const CHOICES: Partial<Record<keyof Settings, readonly unknown[]>> = {
  shadows: [0, 1024, 2048],
  timeOfDay: ['cycle', 'day', 'night'],
  weather: ['dynamic', 'clear'],
  rainParticles: [0, 0.5, 1],
  characters: ['detailed', 'simple'],
};

const KEY = 'owcs.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const out = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      if (k in parsed && typeof parsed[k] === typeof DEFAULT_SETTINGS[k]) {
        if (CHOICES[k] && !CHOICES[k].includes(parsed[k])) continue;
        (out as Record<string, unknown>)[k] = parsed[k];
      }
    }
    return out;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable (private mode); settings just won't persist.
  }
}
