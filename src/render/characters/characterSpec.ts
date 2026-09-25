/**
 * The contract between the character art (a glTF exported from Blender) and the game: file
 * location, clip, bone and material names, authored speeds and budgets. See
 * art/characters/README.md for the artist-facing version.
 *
 * Pure data with no imports, so the Node scripts in scripts/ can load it directly.
 */

/** A single bot model of your own for every bot (`?charmodel=soldier`), relative to the site root (Vite serves public/ there). */
export const CHARACTER_FILE = 'models/characters/soldier.glb';
/** Player character (other players, co-op allies), generated from the SWAT (`npm run models:player`). */
export const PLAYER_FILE = 'models/characters/player.glb';
/** Generated stand-in with the same rig and clips (`npm run models:placeholder`). */
export const PLACEHOLDER_FILE = 'models/characters/placeholder.glb';

/** Bot factions: armoured bots are terrorists, the rest gang members. */
export type BotGroup = 'gang' | 'terrorist';

/**
 * Bot models, generated from the static meshes in art/characters/bots (`npm run models:bots`).
 * Each bot gets one from its group (see variants.ts).
 */
export const BOT_MODELS: readonly { id: string; source: string; group: BotGroup; file: string }[] = (
  [
    ['Gang_Hoodie', 'gang'],
    ['Gang_Biker', 'gang'],
    ['Gang_Tracksuit', 'gang'],
    ['Gang_Tank', 'gang'],
    ['Terrorist_Balaclava', 'terrorist'],
    ['Terrorist_Urban', 'terrorist'],
    ['Terrorist_Desert', 'terrorist'],
    ['Terrorist_Gasmask', 'terrorist'],
  ] as const
).map(([source, group]) => ({ id: source.toLowerCase(), source, group, file: `models/characters/bots/${source.toLowerCase()}.glb` }));

/**
 * Which model to load for a `?charmodel=` / `?playermodel=` URL value: nothing for the default
 * (`fallback`), `placeholder`, `player`, `soldier` or a bot id (`gang_biker`) for the known
 * ones, `none` for the box figures (null), or a path of your own.
 */
export function characterUrl(param: string | null, base: string, fallback = CHARACTER_FILE): string | null {
  if (param === 'none') return null;
  const named: Record<string, string> = { placeholder: PLACEHOLDER_FILE, player: PLAYER_FILE, soldier: CHARACTER_FILE };
  const file = !param ? fallback : (named[param] ?? BOT_MODELS.find((m) => m.id === param)?.file ?? param);
  return /^(\/|https?:)/.test(file) ? file : `${base}${file}`;
}

/**
 * The bot models for a `?charmodel=` value: every BOT_MODELS entry by default, or the one model
 * characterUrl names for all bots (null for the box figures).
 */
export function botModelUrls(param: string | null, base: string): { url: string; group?: BotGroup }[] | null {
  if (!param) return BOT_MODELS.map((m) => ({ url: `${base}${m.file}`, group: m.group }));
  const url = characterUrl(param, base);
  return url ? [{ url }] : null;
}

/**
 * - `loco`: locomotion cycles, phase-synced to each other and to ground speed.
 * - `pose`: free-running loops (idle, airborne).
 * - `overlay`: short one-shots added on top of whatever the body is doing (upper body only).
 * - `death`: plays once and holds its last frame.
 * - `hold`: how the arms hold something other than a long gun, blended in (upper body only, as
 *   the difference from Idle's first frame) while that item is out.
 */
export type ClipKind = 'loco' | 'pose' | 'overlay' | 'death' | 'hold';

export interface ClipSpec {
  name: string;
  kind: ClipKind;
  required: boolean;
  /** Ground speed the cycle was authored for (m/s), locomotion only. */
  speed?: number;
}

/** Authored locomotion speeds (m/s). Tweak these if your cycles were made for other speeds. */
export const WALK_SPEED = 1.6;
export const RUN_SPEED = 5.5;
export const CROUCH_WALK_SPEED = 2.0;

export const CLIPS: readonly ClipSpec[] = [
  { name: 'Idle', kind: 'pose', required: true },
  { name: 'Walk', kind: 'loco', required: true, speed: WALK_SPEED },
  { name: 'Run', kind: 'loco', required: true, speed: RUN_SPEED },
  { name: 'Crouch_Idle', kind: 'pose', required: true },
  { name: 'Crouch_Walk', kind: 'loco', required: true, speed: CROUCH_WALK_SPEED },
  { name: 'Death', kind: 'death', required: true },
  { name: 'Jump', kind: 'pose', required: false },
  { name: 'Walk_Back', kind: 'loco', required: false, speed: WALK_SPEED },
  { name: 'Walk_Left', kind: 'loco', required: false, speed: WALK_SPEED },
  { name: 'Walk_Right', kind: 'loco', required: false, speed: WALK_SPEED },
  { name: 'Run_Back', kind: 'loco', required: false, speed: RUN_SPEED },
  { name: 'Run_Left', kind: 'loco', required: false, speed: RUN_SPEED },
  { name: 'Run_Right', kind: 'loco', required: false, speed: RUN_SPEED },
  { name: 'Shoot', kind: 'overlay', required: false },
  { name: 'Reload', kind: 'overlay', required: false },
  { name: 'Throw', kind: 'overlay', required: false },
  { name: 'Hit', kind: 'overlay', required: false },
  { name: 'Hold_Pistol', kind: 'hold', required: false },
  { name: 'Hold_Knife', kind: 'hold', required: false },
  { name: 'Hold_Grenade', kind: 'hold', required: false },
  { name: 'Hold_Ready', kind: 'hold', required: false },
];

/**
 * Hold clip per weapon category. Rifles, SMGs and snipers use the clips' own aimed hold when
 * standing or shooting, and READY_HOLD (if the model has it) while moving.
 */
export const HOLD_BY_CATEGORY: Readonly<Record<string, string>> = {
  pistol: 'Hold_Pistol',
  knife: 'Hold_Knife',
  grenade: 'Hold_Grenade',
};
export const READY_HOLD = 'Hold_Ready';

export const CLIP_BY_NAME: ReadonlyMap<string, ClipSpec> = new Map(CLIPS.map((c) => [c.name, c]));

/** Node names the code looks up. Bones use underscores: three.js strips dots from names. */
export const NODES = {
  hips: 'Hips',
  /** Everything under Spine is "upper body" for overlays; Spine and Chest bend to aim. */
  spine: 'Spine',
  chest: 'Chest',
  head: 'Head',
  /**
   * Empty in the right hand at the grip. In Blender its arrow (+Z) runs along the barrel and +Y
   * points out of the gun's underside; after the Y-up export that is +Y along the barrel and +Z
   * out of the top.
   */
  weapon: 'Socket_Weapon',
  /** Optional empty for the flashlight beam, same axes as the weapon socket. */
  torch: 'Socket_Torch',
} as const;

export const REQUIRED_NODES: readonly string[] = [NODES.hips, NODES.spine, NODES.head, NODES.weapon];
export const OPTIONAL_NODES: readonly string[] = [NODES.chest, NODES.torch];

/** Materials: `Uniform` is tinted per look (keep it light grey); `Skin` and the rest are left alone. */
export const MATERIALS = { uniform: 'Uniform', skin: 'Skin' } as const;
/** Gear objects shown only when the actor has the item. */
export const GEAR = { helmet: 'Helmet', vest: 'Vest' } as const;

export type LookId = 'bot' | 'dummy' | 'elite' | 'ally';

/** Box-bot palettes per look: [head, torso, stomach, legs, arms, gun]. */
export const BOX_LOOKS: Record<LookId, readonly string[]> = {
  bot: ['#3b3530', '#4a4f3a', '#3f4234', '#5c5140', '#4a4f3a', '#1d1d1d'],
  dummy: ['#c9b48a', '#b89c6a', '#a88d5f', '#8f7a55', '#b89c6a', '#1d1d1d'],
  elite: ['#26282b', '#2b3036', '#25292e', '#383c42', '#2b3036', '#141414'],
  /** Other players (co-op). */
  ally: ['#2f3f52', '#35577a', '#2f4a66', '#3a4f63', '#35577a', '#1d1d1d'],
};

/** Multiplied into the `Uniform` material's colour. */
export const UNIFORM_TINT: Record<LookId, string> = {
  bot: '#8a9168',
  dummy: '#e6d3a8',
  elite: '#50555e',
  ally: '#5f8fc4',
};

export const BUDGET = {
  triangles: 5000,
  materials: 3,
  bones: 40,
  bytes: 2 * 1024 * 1024,
  /** Bind-pose height range (m); the hitboxes top out at 1.79. */
  minHeight: 1.6,
  maxHeight: 2.0,
} as const;
