import { CHUNK } from '../core/config';
import { makeBrush, type Brush, type RampDir } from '../physics/brush';
import { BRUSH_STRIDE, wordContents, wordMaterial, wordRamp } from './gen/ChunkData';

/** Convert packed chunk brushes (cm, chunk-local) into world-space collision brushes. */
export function brushesFromPacked(data: Int32Array, cx: number, cz: number, key: number): Brush[] {
  const ox = cx * CHUNK;
  const oz = cz * CHUNK;
  const n = data.length / BRUSH_STRIDE;
  const out: Brush[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * BRUSH_STRIDE;
    const w = data[o + 6];
    out[i] = makeBrush(
      ox + data[o] / 100,
      data[o + 1] / 100,
      oz + data[o + 2] / 100,
      ox + data[o + 3] / 100,
      data[o + 4] / 100,
      oz + data[o + 5] / 100,
      wordContents(w),
      wordMaterial(w),
      wordRamp(w) as RampDir,
      key,
    );
  }
  return out;
}
