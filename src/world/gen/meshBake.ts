import { Contents, Ramp } from '../../physics/brush';
import {
  BRUSH_STRIDE,
  Material,
  MATERIAL_COUNT,
  wordContents,
  wordMaterial,
  wordRamp,
  type MeshData,
} from './ChunkData';

/** Texture repeat size in meters per material (all divide the 64 m chunk so seams line up). 0 = per-face box UVs. */
export const MATERIAL_TILE: Record<number, number> = {
  [Material.Concrete]: 4,
  [Material.Plaster]: 4,
  [Material.Brick]: 2,
  [Material.Asphalt]: 8,
  [Material.Sidewalk]: 2,
  [Material.Crate]: 0,
  [Material.Metal]: 2,
  [Material.Dev]: 2,
  [Material.Wood]: 2,
  [Material.Paint]: 2,
  [Material.CarPaint]: 0,
  [Material.CarGlass]: 0,
  [Material.CarWheel]: 0,
  [Material.CarTrim]: 0,
  [Material.LampGlow]: 0,
};

type Rgb = readonly [number, number, number];

/** Container / painted-metal colors chosen by brush tint. */
const METAL_PALETTE: readonly Rgb[] = [
  [0.62, 0.16, 0.12],
  [0.14, 0.3, 0.52],
  [0.2, 0.42, 0.22],
  [0.78, 0.44, 0.1],
  [0.55, 0.55, 0.52],
  [0.36, 0.2, 0.36],
];

/** Car paint colors, weighted towards the whites, silvers and blacks of a real street. */
export const CAR_PAINT_PALETTE: readonly Rgb[] = [
  [0.92, 0.92, 0.9],
  [0.7, 0.72, 0.74],
  [0.12, 0.12, 0.13],
  [0.4, 0.42, 0.44],
  [0.55, 0.08, 0.08],
  [0.1, 0.16, 0.34],
  [0.86, 0.86, 0.84],
  [0.6, 0.62, 0.64],
  [0.16, 0.26, 0.18],
  [0.66, 0.6, 0.48],
  [0.2, 0.2, 0.22],
  [0.26, 0.4, 0.58],
];

/** Car trim colors by tint index. */
export const CarTrim = { Plastic: 0, Chrome: 1, Headlight: 2, Taillight: 3, Amber: 4, Plate: 5 } as const;
const CAR_TRIM_PALETTE: readonly Rgb[] = [
  [0.1, 0.1, 0.1],
  [0.72, 0.73, 0.75],
  [1, 0.97, 0.86],
  [0.72, 0.06, 0.05],
  [0.95, 0.5, 0.08],
  [0.95, 0.95, 0.92],
];

const NEUTRAL: readonly Rgb[] = [[1, 1, 1]];

/** Materials whose color comes from a palette indexed by brush tint. */
const PALETTES: Record<number, readonly Rgb[]> = {
  [Material.Metal]: METAL_PALETTE,
  [Material.CarPaint]: CAR_PAINT_PALETTE,
  [Material.CarTrim]: CAR_TRIM_PALETTE,
  [Material.CarGlass]: NEUTRAL,
  [Material.CarWheel]: NEUTRAL,
  [Material.LampGlow]: NEUTRAL,
};

/** Materials that skip ground-contact AO (small floating details; shading is in the texture). */
const NO_AO = new Set<number>([Material.CarPaint, Material.CarGlass, Material.CarWheel, Material.CarTrim, Material.LampGlow]);

/** Height over which the fake ground-contact AO fades out. */
const AO_HEIGHT = 1.2;
const AO_MIN = 0.55;

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  get vertexCount() {
    return this.pos.length / 3;
  }
  finish(material: number): MeshData {
    return {
      material,
      positions: new Float32Array(this.pos),
      normals: new Int8Array(this.nrm),
      uvs: new Float32Array(this.uv),
      colors: new Uint8Array(this.col),
      indices: new Uint32Array(this.idx),
    };
  }
}

interface BrushInfo {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  material: number;
  tile: number;
  ao: boolean;
  r: number;
  g: number;
  b: number;
}

function aoAt(y: number, base: number): number {
  const t = (y - base) / AO_HEIGHT;
  return AO_MIN + (1 - AO_MIN) * (t < 0 ? 0 : t > 1 ? 1 : t);
}

/**
 * Emit a planar polygon (3 or 4 corners). Winding is fixed up to face along (nx, ny, nz).
 * `vertical` faces get ground-contact AO.
 */
function emit(
  bld: Builder,
  info: BrushInfo,
  corners: number[][],
  nx: number,
  ny: number,
  nz: number,
  vertical: boolean,
): void {
  const base = bld.vertexCount;
  const { tile, x0, y0, z0, x1, y1, z1 } = info;
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  for (const c of corners) {
    const [x, y, z] = c;
    bld.pos.push(x, y, z);
    bld.nrm.push(Math.round(nx * 127), Math.round(ny * 127), Math.round(nz * 127));
    let u: number;
    let v: number;
    if (tile === 0) {
      // Box mapping: each face spans the full texture.
      if (ay >= ax && ay >= az) {
        u = (x - x0) / (x1 - x0);
        v = (z - z0) / (z1 - z0);
      } else if (ax >= az) {
        u = (z - z0) / (z1 - z0);
        v = (y - y0) / (y1 - y0);
      } else {
        u = (x - x0) / (x1 - x0);
        v = (y - y0) / (y1 - y0);
      }
    } else if (ay >= ax && ay >= az) {
      u = x / tile;
      v = z / tile;
    } else if (ax >= az) {
      u = z / tile;
      v = y / tile;
    } else {
      u = x / tile;
      v = y / tile;
    }
    bld.uv.push(u, v);
    const ao = vertical && info.ao ? aoAt(y, y0) : 1;
    bld.col.push(
      Math.round(Math.min(1, info.r * ao) * 255),
      Math.round(Math.min(1, info.g * ao) * 255),
      Math.round(Math.min(1, info.b * ao) * 255),
    );
  }
  // Fix winding: triangle (0,1,2) normal must agree with the face normal.
  const [a, b, c] = corners;
  const e1x = b[0] - a[0];
  const e1y = b[1] - a[1];
  const e1z = b[2] - a[2];
  const e2x = c[0] - a[0];
  const e2y = c[1] - a[1];
  const e2z = c[2] - a[2];
  const cx = e1y * e2z - e1z * e2y;
  const cy = e1z * e2x - e1x * e2z;
  const cz = e1x * e2y - e1y * e2x;
  const flip = cx * nx + cy * ny + cz * nz < 0;
  const tri = (i: number, j: number, k: number) => {
    if (flip) bld.idx.push(base + i, base + k, base + j);
    else bld.idx.push(base + i, base + j, base + k);
  };
  tri(0, 1, 2);
  if (corners.length === 4) tri(0, 2, 3);
}

/** Emit a vertical side face between y0 and the (possibly sloped) top, splitting for AO. */
function emitSide(
  bld: Builder,
  info: BrushInfo,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  topA: number,
  topB: number,
  nx: number,
  nz: number,
): void {
  const y0 = info.y0;
  if (topA <= y0 + 1e-6 && topB <= y0 + 1e-6) return;
  if (topA <= y0 + 1e-6) {
    emit(bld, info, [[ax, y0, az], [bx, y0, bz], [bx, topB, bz]], nx, 0, nz, true);
    return;
  }
  if (topB <= y0 + 1e-6) {
    emit(bld, info, [[ax, y0, az], [bx, y0, bz], [ax, topA, az]], nx, 0, nz, true);
    return;
  }
  const split = y0 + AO_HEIGHT;
  if (topA > split + 0.05 && topB > split + 0.05) {
    emit(bld, info, [[ax, y0, az], [bx, y0, bz], [bx, split, bz], [ax, split, az]], nx, 0, nz, true);
    emit(bld, info, [[ax, split, az], [bx, split, bz], [bx, topB, bz], [ax, topA, az]], nx, 0, nz, true);
  } else {
    emit(bld, info, [[ax, y0, az], [bx, y0, bz], [bx, topB, bz], [ax, topA, az]], nx, 0, nz, true);
  }
}

/** Build per-material render meshes (chunk-local positions) from packed brushes. */
export function bakeMeshes(brushes: Int32Array): MeshData[] {
  const builders: (Builder | null)[] = new Array(MATERIAL_COUNT).fill(null);
  const n = brushes.length / BRUSH_STRIDE;
  const info: BrushInfo = { x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0, material: 0, tile: 1, ao: true, r: 1, g: 1, b: 1 };

  for (let i = 0; i < n; i++) {
    const o = i * BRUSH_STRIDE;
    const word = brushes[o + 6];
    if ((wordContents(word) & Contents.VISIBLE) === 0) continue;
    const material = wordMaterial(word);
    const ramp = wordRamp(word);
    const tint = brushes[o + 7];
    info.x0 = brushes[o] / 100;
    info.y0 = brushes[o + 1] / 100;
    info.z0 = brushes[o + 2] / 100;
    info.x1 = brushes[o + 3] / 100;
    info.y1 = brushes[o + 4] / 100;
    info.z1 = brushes[o + 5] / 100;
    info.material = material;
    info.tile = MATERIAL_TILE[material] ?? 2;
    info.ao = !NO_AO.has(material);
    const palette = PALETTES[material];
    if (palette) {
      const c = palette[tint % palette.length];
      info.r = c[0];
      info.g = c[1];
      info.b = c[2];
    } else {
      const v = 0.84 + 0.16 * (tint / 255);
      const warm = ((tint * 7) % 11) / 11 - 0.5;
      info.r = v * (1 + warm * 0.04);
      info.g = v;
      info.b = v * (1 - warm * 0.04);
    }
    let bld = builders[material];
    if (!bld) bld = builders[material] = new Builder();

    const { x0, y0, z0, x1, y1, z1 } = info;
    // Top heights at the 4 corners (00, 10, 11, 01 in x/z).
    let t00 = y1;
    let t10 = y1;
    let t11 = y1;
    let t01 = y1;
    switch (ramp) {
      case Ramp.PosX:
        t00 = t01 = y0;
        break;
      case Ramp.NegX:
        t10 = t11 = y0;
        break;
      case Ramp.PosZ:
        t00 = t10 = y0;
        break;
      case Ramp.NegZ:
        t01 = t11 = y0;
        break;
    }

    // Top (flat or sloped).
    let tnx = 0;
    let tny = 1;
    let tnz = 0;
    if (ramp !== Ramp.None) {
      const h = y1 - y0;
      if (ramp === Ramp.PosX) tnx = -h / (x1 - x0);
      else if (ramp === Ramp.NegX) tnx = h / (x1 - x0);
      else if (ramp === Ramp.PosZ) tnz = -h / (z1 - z0);
      else tnz = h / (z1 - z0);
      const l = Math.hypot(tnx, 1, tnz);
      tnx /= l;
      tny = 1 / l;
      tnz /= l;
    }
    emit(bld, info, [[x0, t00, z0], [x1, t10, z0], [x1, t11, z1], [x0, t01, z1]], tnx, tny, tnz, false);

    // Bottom only for floating brushes.
    if (y0 > 0.001) emit(bld, info, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], 0, -1, 0, false);

    // Sides.
    emitSide(bld, info, x0, z0, x1, z0, t00, t10, 0, -1); // -Z
    emitSide(bld, info, x1, z1, x0, z1, t11, t01, 0, 1); // +Z
    emitSide(bld, info, x0, z1, x0, z0, t01, t00, -1, 0); // -X
    emitSide(bld, info, x1, z0, x1, z1, t10, t11, 1, 0); // +X
  }

  const out: MeshData[] = [];
  builders.forEach((b, m) => {
    if (b && b.vertexCount > 0) out.push(b.finish(m));
  });
  return out;
}
