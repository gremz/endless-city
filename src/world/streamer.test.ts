import { describe, expect, it } from 'vitest';
import { LOAD_RADIUS } from '../core/config';
import { CollisionWorld } from '../physics/CollisionWorld';
import { chunkKey } from './chunkMath';
import { BrushWriter } from './gen/BrushWriter';
import { glassPieces, type ChunkData } from './gen/ChunkData';
import { SyncChunkSource, WorldStreamer } from './WorldStreamer';

function emptyChunk(seed: number, cx: number, cz: number): ChunkData {
  return {
    cx,
    cz,
    key: chunkKey(cx, cz),
    seed,
    brushes: new BrushWriter().finish(),
    meshes: [],
    district: 0,
    landmark: 0,
    level: 0,
    navCol: new Uint16Array(0),
    navFloor: new Int16Array(0),
    navFlags: new Uint8Array(0),
    navCover: new Uint8Array(0),
    navLinks: new Float32Array(0),
    spawns: new Float32Array(0),
    perches: new Float32Array(0),
    patrol: new Float32Array(0),
    pickups: new Float32Array(0),
    vehicles: new Float32Array(0),
    doors: new Float32Array(0),
    pieces: glassPieces([]),
    navPatch: new Int32Array(0),
    hasEncounter: false,
    genMs: 0,
  };
}

describe('WorldStreamer', () => {
  it('keeps the world loaded around every player', () => {
    const streamer = new WorldStreamer(new CollisionWorld(), new SyncChunkSource(1, emptyChunk));
    const far = 20 * 64 + 32;
    const points = [
      { x: 32, z: 32 },
      { x: far, z: 32 },
    ];
    for (let i = 0; i < 200; i++) {
      streamer.updateAround(points);
      streamer.apply(16, 16);
    }
    for (const [cx, cz] of [
      [0, 0],
      [20, 0],
      [LOAD_RADIUS, 0],
      [20 - LOAD_RADIUS, 0],
    ]) {
      expect(streamer.resident.get(chunkKey(cx, cz))?.visible).toBe(true);
    }
    // Nothing loaded in between the two groups.
    expect(streamer.resident.has(chunkKey(10, 0))).toBe(false);

    // One player leaves: their area unloads, the other stays.
    for (let i = 0; i < 200; i++) {
      streamer.updateAround(points.slice(0, 1));
      streamer.apply(16, 16);
    }
    expect(streamer.resident.has(chunkKey(0, 0))).toBe(true);
    expect(streamer.resident.has(chunkKey(20, 0))).toBe(false);
  });
});
