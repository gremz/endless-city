/** 1 Hammer unit in meters. Movement constants are written as `n * HU` so they read like CS values. */
export const HU = 0.0254;

/** Simulation tick rate (CS default 64 tick). */
export const TICK_RATE = 64;
export const TICK = 1 / TICK_RATE;

/** Max sim ticks run per rendered frame before the accumulator is dropped. */
export const MAX_TICKS_PER_FRAME = 8;

/** Chunk edge length in meters. Layout math inside a chunk uses quarter-meter integers (0..256). */
export const CHUNK = 64;
export const QUARTERS_PER_CHUNK = CHUNK * 4;

/** Chunks within this Chebyshev radius are loaded and visible. */
export const LOAD_RADIUS = 2;
/** Chunks beyond this radius are unloaded (between LOAD_RADIUS and this they stay resident but hidden). */
export const UNLOAD_RADIUS = 3;

export const FOG_NEAR = 60;
export const FOG_FAR = 150;
export const CAMERA_FAR = 200;
