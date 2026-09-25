import { Contents } from '../physics/brush';
import { BRUSH_STRIDE, Material, wordContents, wordMaterial, type ChunkData } from '../world/gen/ChunkData';

/** Top-down colour per brush material. */
const COLORS: Record<number, string> = {
  [Material.Concrete]: '#8d8d88',
  [Material.Plaster]: '#cdb78d',
  [Material.Brick]: '#8a4a36',
  [Material.Asphalt]: '#3b3b3e',
  [Material.Sidewalk]: '#a8a7a2',
  [Material.Crate]: '#9b6a30',
  [Material.Metal]: '#4a6f8f',
  [Material.Dev]: '#b8b0a4',
  [Material.Wood]: '#7a5230',
  [Material.Paint]: '#eeeeee',
  [Material.CarPaint]: '#7d8a99',
  [Material.CarGlass]: '#2a323c',
  [Material.CarWheel]: '#1c1c1c',
  [Material.CarTrim]: '#262626',
  [Material.LampGlow]: '#d8d2bd',
  [Material.Glass]: '#9fb7c4',
  [Material.Water]: '#2f5f7a',
  [Material.Grass]: '#4d6b34',
  [Material.Stone]: '#a9a49a',
  [Material.CurtainWall]: '#4f6272',
};

/**
 * Draw a chunk's visible brushes as a top-down map with its north-west corner at (ox, oz).
 * Brushes draw lowest top first, and taller ones are more opaque, so buildings stand out.
 */
export function drawChunkTopdown(ctx: CanvasRenderingContext2D, d: ChunkData, px: number, ox: number, oz: number): void {
  const b = d.brushes;
  const order: number[] = [];
  for (let i = 0; i < b.length; i += BRUSH_STRIDE) order.push(i);
  order.sort((x, y) => b[x + 4] - b[y + 4]);
  for (const o of order) {
    if (!(wordContents(b[o + 6]) & Contents.VISIBLE)) continue;
    // Facade dressing and roof skins would hide the building colours.
    const mat = wordMaterial(b[o + 6]);
    if (mat === Material.Facade || mat === Material.RoofTar) continue;
    const h = b[o + 4] / 100;
    ctx.fillStyle = COLORS[mat] ?? '#f0f';
    ctx.globalAlpha = 0.55 + Math.min(0.45, h / 20);
    ctx.fillRect(ox + (b[o] / 100) * px, oz + (b[o + 2] / 100) * px, ((b[o + 3] - b[o]) / 100) * px, ((b[o + 5] - b[o + 2]) / 100) * px);
  }
  ctx.globalAlpha = 1;
}
