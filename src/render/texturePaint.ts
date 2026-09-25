import { fmix32, sfc32, type Rand } from '../core/rng';
import { Material } from '../world/gen/ChunkData';

/**
 * Procedural canvas textures, so the game ships with zero art assets. DOM-free (OffscreenCanvas)
 * so it runs in texture.worker.ts; textures.ts turns the results into three.js textures.
 */

type Ctx = OffscreenCanvasRenderingContext2D;

const SIZE = 256;
/** World surfaces (walls, ground) are painted at this size, with a height field for a normal map. */
const HI = 512;

function canvas(size = SIZE): [OffscreenCanvas, Ctx] {
  const c = new OffscreenCanvas(size, size);
  // CPU-backed: painters read pixels back (height fields, final upload), which is slow on GPU canvases.
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  return [c, ctx];
}

/** A painted material: color, plus an optional height field (for a normal map) and glow. */
export interface Painted {
  color: OffscreenCanvas;
  /** Row-major heights in 0..1, the size of `color`. */
  height?: Float32Array;
  /** Normal map bumpiness: slope scale applied to the height field. */
  bump?: number;
  emissive?: OffscreenCanvas;
}

/**
 * Tileable value noise sampled on a coarse lattice with smooth interpolation. A different
 * `cellsY` stretches it (few cells down, many across = vertical streaks).
 */
function makeNoise(r: Rand, cells: number, cellsY = cells): (x: number, y: number) => number {
  const g = new Float32Array(cells * cellsY);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const at = (x: number, y: number) => g[((y % cellsY) + cellsY) % cellsY * cells + (((x % cells) + cells) % cells)];
  return (x: number, y: number) => {
    const fx = x * cells;
    const fy = y * cellsY;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
    const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
    return a + (b - a) * sy;
  };
}

function fbm(noises: ((x: number, y: number) => number)[], x: number, y: number): number {
  let v = 0;
  let amp = 0.5;
  let total = 0;
  for (const n of noises) {
    v += n(x, y) * amp;
    total += amp;
    amp *= 0.5;
  }
  return v / total;
}

/** Fill every pixel from a color function (r, g, b in 0..255). */
function paint(ctx: Ctx, fn: (u: number, v: number, x: number, y: number) => [number, number, number]) {
  const size = ctx.canvas.width;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = fn(x / size, y / size, x, y);
      const o = (y * size + x) * 4;
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Stable 0..1 random for integer cell coordinates (per brick, per block). */
const cellRand = (a: number, b: number, salt: number) => fmix32(fmix32(fmix32(salt) ^ a) ^ b) / 4294967296;

/** Multiply a canvas by a height-shaped shade (lower = darker), so grooves read at a distance. */
function shadeByHeight(ctx: Ctx, h: Float32Array, amount: number): void {
  const size = ctx.canvas.width;
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < h.length; i++) {
    const k = 1 - amount * (1 - h[i]);
    d[i * 4] *= k;
    d[i * 4 + 1] *= k;
    d[i * 4 + 2] *= k;
  }
  ctx.putImageData(img, 0, 0);
}

/** Lower the height field wherever a grayscale drawing is dark (for canvas-drawn cracks and seams). */
function carve(h: Float32Array, size: number, depth: number, draw: (ctx: Ctx) => void): void {
  const [, ctx] = canvas(size);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  draw(ctx);
  const d = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0; i < h.length; i++) h[i] -= (1 - d[i * 4] / 255) * depth;
}

/** Tangent-space normal map from a wrapping height field (canvas up = +v). */
function heightToNormal(h: Float32Array, size: number, bump: number): OffscreenCanvas {
  const [c, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    const up = ((y - 1 + size) % size) * size;
    const dn = ((y + 1) % size) * size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const l = h[row + ((x - 1 + size) % size)];
      const r = h[row + ((x + 1) % size)];
      const nx = -(r - l) * bump;
      const ny = (h[dn + x] - h[up + x]) * bump;
      const inv = 1 / Math.hypot(nx, ny, 1);
      const o = (row + x) * 4;
      d[o] = (nx * inv * 0.5 + 0.5) * 255;
      d[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
      d[o + 2] = (inv * 0.5 + 0.5) * 255;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Vertical grime: dark drip streaks (tileable), 0 = clean, up to ~1 in the worst streaks. */
function makeStreaks(r: Rand): (u: number, v: number) => number {
  const coarse = makeNoise(r, 24, 2);
  const fine = makeNoise(r, 96, 3);
  return (u, v) => {
    const s = coarse(u, v) * 0.65 + fine(u, v) * 0.35;
    return Math.max(0, s - 0.52) * 3;
  };
}

function concrete(): Painted {
  const [c, ctx] = canvas(HI);
  const r = sfc32(11);
  const n = [makeNoise(r, 4), makeNoise(r, 8), makeNoise(r, 16), makeNoise(r, 64), makeNoise(r, 160)];
  const streak = makeStreaks(r);
  const h = new Float32Array(HI * HI);
  const half = HI / 2;
  paint(ctx, (u, v, x, y) => {
    const f = fbm(n, u, v);
    const s = r() * 12 - 6;
    const st = streak(u, v) * 28;
    let hv = 0.6 + (n[4](u, v) - 0.5) * 0.25 + (f - 0.5) * 0.2;
    // Formwork seams: shallow V grooves.
    const sd = Math.min(Math.abs(x - half), Math.abs(y - half), x, y, HI - x, HI - y);
    if (sd < 3) hv -= (3 - sd) * 0.12;
    // Tie holes sit on a 128 px grid (offset 64) in rows 64 and 320.
    const hx = ((x - 64) % 128 + 128) % 128;
    const dd = Math.hypot(Math.min(hx, 128 - hx), Math.min(Math.abs(y - 64), Math.abs(y - 320)));
    const hole = dd < 5 ? 1 - dd / 5 : 0;
    hv -= hole * 0.5;
    h[y * HI + x] = hv;
    const base = 150 + (f - 0.5) * 60 + s - st - hole * 40;
    return [clamp255(base), clamp255(base - 2), clamp255(base - 6)];
  });
  shadeByHeight(ctx, h.map(clamp01), 0.3);
  return { color: c, height: h, bump: 3 };
}

function plaster(): Painted {
  const [c, ctx] = canvas(HI);
  const r = sfc32(22);
  const n = [makeNoise(r, 3), makeNoise(r, 6), makeNoise(r, 12), makeNoise(r, 48)];
  const grain = makeNoise(r, 200);
  const stain = makeNoise(r, 5);
  const streak = makeStreaks(r);
  const h = new Float32Array(HI * HI);
  // Near-neutral (the district palette colours it), with stains, grime and a stucco grain.
  paint(ctx, (u, v, x, y) => {
    const f = fbm(n, u, v);
    const g = grain(u, v);
    const s = r() * 8 - 4;
    const st = Math.max(0, stain(u, v) - 0.55) * 70 + streak(u, v) * 26;
    h[y * HI + x] = 0.7 + (g - 0.5) * 0.35 + (f - 0.5) * 0.1 + (r() - 0.5) * 0.06;
    const k = 226 + (f - 0.5) * 36 + (g - 0.5) * 14 + s - st;
    return [clamp255(k + 2), clamp255(k), clamp255(k - 4)];
  });
  // Hairline cracks, carved into the height field as well.
  const cracks: [number, number][][] = [];
  for (let i = 0; i < 7; i++) {
    let x = r() * HI;
    let y = r() * HI;
    const pts: [number, number][] = [[x, y]];
    for (let k = 0; k < 10; k++) {
      x += (r() - 0.5) * 40;
      y += r() * 26;
      pts.push([x, y]);
    }
    cracks.push(pts);
  }
  const drawCracks = (g: Ctx, style: string, w: number) => {
    g.strokeStyle = style;
    g.lineWidth = w;
    for (const pts of cracks) {
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (const [px, py] of pts) g.lineTo(px, py);
      g.stroke();
    }
  };
  drawCracks(ctx, 'rgba(70,64,58,0.4)', 1.2);
  carve(h, HI, 0.4, (g) => drawCracks(g, '#000', 1.5));
  return { color: c, height: h, bump: 2.2 };
}

/** Brick: 8 x 32 stretcher courses per 2 m tile; light and warm, the palette sets red/buff/brown. */
function brick(): Painted {
  const [c, ctx] = canvas(HI);
  const r = sfc32(33);
  const bw = 64;
  const bh = 16;
  const mortar = 2.5;
  const n = makeNoise(r, 32);
  const fine = makeNoise(r, 128);
  const streak = makeStreaks(r);
  const h = new Float32Array(HI * HI);
  paint(ctx, (u, v, x, y) => {
    const row = Math.floor(y / bh);
    const off = row % 2 ? bw / 2 : 0;
    const col = Math.floor((x + off) / bw) % (HI / bw);
    const lx = (x + off) % bw;
    const ly = y % bh;
    const edge = Math.min(lx, bw - 1 - lx, ly, bh - 1 - ly);
    const k = cellRand(row, col, 33);
    const k2 = cellRand(row, col, 34);
    const grime = streak(u, v) * 22 + (n(u, v) - 0.5) * 26;
    const fn = (fine(u, v) - 0.5) * 18 + (r() - 0.5) * 10;
    if (edge < mortar) {
      h[y * HI + x] = 0.25 + (r() - 0.5) * 0.08;
      const m = 228 + fn * 0.6 - grime * 0.8;
      return [clamp255(m), clamp255(m - 3), clamp255(m - 10)];
    }
    // Rounded arrises, a slightly uneven face per brick.
    const bevel = Math.min(1, (edge - mortar) / 2.5);
    h[y * HI + x] = 0.55 + bevel * 0.3 + (fine(u, v) - 0.5) * 0.08 + (k2 - 0.5) * 0.06;
    // A few overburnt (dark) and pale bricks among the regular ones.
    const burnt = k2 > 0.9 ? 0.72 : k2 < 0.07 ? 1.08 : 1;
    const base = (212 + (k - 0.5) * 40 + fn - grime) * burnt;
    return [clamp255(base), clamp255(base * 0.86), clamp255(base * 0.76)];
  });
  shadeByHeight(ctx, h, 0.25);
  return { color: c, height: h, bump: 4 };
}

function asphalt(): Painted {
  const [c, ctx] = canvas(HI);
  const r = sfc32(44);
  const n = [makeNoise(r, 4), makeNoise(r, 16), makeNoise(r, 64)];
  const h = new Float32Array(HI * HI);
  paint(ctx, (u, v, x, y) => {
    const f = fbm(n, u, v);
    const stone = r() < 0.08;
    const s = stone ? 25 : r() * 12 - 6;
    h[y * HI + x] = 0.5 + (stone ? 0.3 : (r() - 0.5) * 0.25);
    const base = 64 + (f - 0.5) * 30 + s;
    return [clamp255(base), clamp255(base), clamp255(base + 3)];
  });
  const cracks = (g: Ctx, style: string) => {
    const cr = sfc32(45);
    g.strokeStyle = style;
    g.lineWidth = 2;
    for (let i = 0; i < 4; i++) {
      let x = cr() * HI;
      let y = cr() * HI;
      g.beginPath();
      g.moveTo(x, y);
      for (let k = 0; k < 14; k++) {
        x += (cr() - 0.5) * 50;
        y += (cr() - 0.5) * 50;
        g.lineTo(x, y);
      }
      g.stroke();
    }
  };
  cracks(ctx, 'rgba(20,20,20,0.5)');
  carve(h, HI, 0.5, (g) => cracks(g, '#000'));
  return { color: c, height: h, bump: 1.5 };
}

function sidewalk(): Painted {
  const [c, ctx] = canvas(HI);
  const r = sfc32(55);
  const n = [makeNoise(r, 8), makeNoise(r, 32), makeNoise(r, 128)];
  const t = HI / 4;
  const h = new Float32Array(HI * HI);
  paint(ctx, (u, v, x, y) => {
    const f = fbm(n, u, v);
    const i = Math.floor(x / t);
    const j = Math.floor(y / t);
    const slab = (cellRand(i, j, 55) - 0.5) * 16;
    const ex = Math.min(x % t, t - 1 - (x % t), y % t, t - 1 - (y % t));
    const joint = ex < 2 ? 1 : 0;
    h[y * HI + x] = joint ? 0.2 : 0.6 + (n[2](u, v) - 0.5) * 0.2 + (r() - 0.5) * 0.08 + Math.min(1, (ex - 2) / 3) * 0.1;
    const base = 168 + (f - 0.5) * 30 + r() * 10 - 5 + slab - joint * 55;
    return [clamp255(base), clamp255(base - 1), clamp255(base - 4)];
  });
  return { color: c, height: h, bump: 2.5 };
}

function woodBase(ctx: Ctx, r: Rand, horizontal: boolean, tone = 1) {
  const grain = makeNoise(r, 8);
  const fine = makeNoise(r, 64);
  paint(ctx, (u, v) => {
    const a = horizontal ? v : u;
    const b = horizontal ? u : v;
    const g = Math.sin((a * 40 + grain(u, v) * 6) * Math.PI) * 0.5 + 0.5;
    const f = fine(b * 0.2, a * 4);
    const base = (150 + g * 30 + (f - 0.5) * 30) * tone;
    return [clamp255(base), clamp255(base * 0.74), clamp255(base * 0.45)];
  });
}

function crate(): OffscreenCanvas {
  const [c, ctx] = canvas();
  const r = sfc32(66);
  woodBase(ctx, r, true);
  // Plank gaps.
  ctx.fillStyle = 'rgba(40,25,10,0.5)';
  for (let i = 1; i < 6; i++) ctx.fillRect(0, (i * SIZE) / 6 - 1, SIZE, 2);
  // Frame and X brace.
  const fw = 26;
  const drawBoard = (x: number, y: number, w: number, h: number) => {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(x + 2, y + 2, w, h);
    ctx.fillStyle = '#a57a45';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(255,230,190,0.15)';
    ctx.fillRect(x, y, w, 3);
  };
  drawBoard(0, 0, SIZE, fw);
  drawBoard(0, SIZE - fw, SIZE, fw);
  drawBoard(0, 0, fw, SIZE);
  drawBoard(SIZE - fw, 0, fw, SIZE);
  ctx.save();
  ctx.beginPath();
  ctx.rect(fw, fw, SIZE - fw * 2, SIZE - fw * 2);
  ctx.clip();
  ctx.lineCap = 'butt';
  for (const [a, b] of [[[0, 0], [SIZE, SIZE]], [[SIZE, 0], [0, SIZE]]] as const) {
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = fw;
    ctx.beginPath();
    ctx.moveTo(a[0] + 3, a[1] + 3);
    ctx.lineTo(b[0] + 3, b[1] + 3);
    ctx.stroke();
    ctx.strokeStyle = '#a57a45';
    ctx.lineWidth = fw - 4;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }
  ctx.restore();
  // Nails.
  ctx.fillStyle = '#3a3a3a';
  for (const [x, y] of [[13, 13], [SIZE - 13, 13], [13, SIZE - 13], [SIZE - 13, SIZE - 13], [SIZE / 2, 13], [SIZE / 2, SIZE - 13]]) {
    ctx.fillRect(x - 2, y - 2, 4, 4);
  }
  return c;
}

function wood(): Painted {
  const [c, ctx] = canvas(HI);
  const r = sfc32(77);
  woodBase(ctx, r, true, 0.9);
  const plank = HI / 8;
  const h = new Float32Array(HI * HI);
  const fine = makeNoise(r, 16, 128);
  for (let y = 0; y < HI; y++) {
    const ly = y % plank;
    const edge = Math.min(ly, plank - 1 - ly);
    for (let x = 0; x < HI; x++) h[y * HI + x] = edge < 2 ? 0.1 : 0.6 + Math.min(1, (edge - 2) / 3) * 0.2 + (fine(x / HI, y / HI) - 0.5) * 0.12;
  }
  ctx.fillStyle = 'rgba(30,18,8,0.6)';
  for (let i = 1; i <= 8; i++) ctx.fillRect(0, i * plank - 2, HI, 4);
  return { color: c, height: h, bump: 3 };
}

function metal(): Painted {
  const [c, ctx] = canvas(HI);
  const r = sfc32(88);
  const n = [makeNoise(r, 4), makeNoise(r, 16), makeNoise(r, 96)];
  const rust = makeNoise(r, 6);
  const streak = makeStreaks(r);
  const h = new Float32Array(HI * HI);
  paint(ctx, (u, v, x, y) => {
    // Corrugation: 12 vertical ridges per tile, mostly in the normal map now.
    const ridge = Math.sin(u * Math.PI * 2 * 12);
    const f = fbm(n, u, v);
    h[y * HI + x] = ridge * 0.5 + 0.5;
    const base = 200 + ridge * 14 + (f - 0.5) * 22 - streak(u, v) * 20;
    const rr = Math.max(0, rust(u, v) - 0.62) * 300 + Math.max(0, streak(u, v) - 0.5) * 60;
    return [clamp255(base - rr * 0.2), clamp255(base - rr * 0.55), clamp255(base - rr * 0.8)];
  });
  // Sheet laps: a horizontal seam with rivets halfway up the tile.
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(0, HI / 2 - 1, HI, 3);
  for (let y = HI / 2 - 2; y <= HI / 2 + 2; y++) for (let x = 0; x < HI; x++) h[y * HI + x] -= 0.25;
  return { color: c, height: h, bump: 2.5 };
}

/** Ashlar stone: 0.5 m courses of 1 m blocks per 4 m tile (plinths, quoins, cornices). */
function stone(): Painted {
  const [c, ctx] = canvas(HI);
  const r = sfc32(99);
  const course = 64;
  const block = 128;
  const joint = 2.5;
  const n = [makeNoise(r, 6), makeNoise(r, 24), makeNoise(r, 96)];
  const streak = makeStreaks(r);
  const h = new Float32Array(HI * HI);
  paint(ctx, (u, v, x, y) => {
    const row = Math.floor(y / course);
    const off = Math.floor(cellRand(row, 0, 98) * 4) * 32;
    const col = Math.floor((x + off) / block) % (HI / block);
    const lx = (x + off) % block;
    const ly = y % course;
    const edge = Math.min(lx, block - 1 - lx, ly, course - 1 - ly);
    const k = cellRand(row, col, 99);
    const f = fbm(n, u, v);
    const st = streak(u, v) * 26;
    if (edge < joint) {
      h[y * HI + x] = 0.2;
      const m = 150 - st;
      return [clamp255(m), clamp255(m - 2), clamp255(m - 6)];
    }
    h[y * HI + x] = 0.55 + Math.min(1, (edge - joint) / 4) * 0.3 + (n[2](u, v) - 0.5) * 0.12;
    const base = 196 + (k - 0.5) * 26 + (f - 0.5) * 34 + (r() - 0.5) * 10 - st;
    return [clamp255(base), clamp255(base - 4), clamp255(base - 12)];
  });
  shadeByHeight(ctx, h, 0.3);
  return { color: c, height: h, bump: 3.5 };
}

/** Flat roof: bitumen membrane with gravel, lap seams every meter and damp patches. */
function roofTar(): Painted {
  const [c, ctx] = canvas(HI);
  const r = sfc32(144);
  const n = [makeNoise(r, 3), makeNoise(r, 10), makeNoise(r, 40)];
  const damp = makeNoise(r, 5);
  const h = new Float32Array(HI * HI);
  const lap = HI / 4;
  paint(ctx, (u, v, x, y) => {
    const f = fbm(n, u, v);
    const pebble = r();
    const ly = y % lap;
    const seam = ly < 4 ? 1 - ly / 4 : 0;
    h[y * HI + x] = 0.45 + (pebble > 0.7 ? (pebble - 0.7) * 1.2 : 0) + seam * 0.3;
    const wet = Math.max(0, damp(u, v) - 0.6) * 90;
    const base = 78 + (f - 0.5) * 30 + (pebble - 0.5) * 34 - wet + seam * 18;
    return [clamp255(base + 2), clamp255(base), clamp255(base - 2)];
  });
  return { color: c, height: h, bump: 2 };
}

/**
 * Curtain wall glazing: 8 bays of 1.6 m per 12.8 m tile (u), stretched over a floor's glass band
 * (v). Some bays are lit offices at night (the emissive map).
 */
function curtainWall(): Painted {
  const [c, ctx] = canvas(HI);
  const [e, ectx] = canvas(HI);
  const r = sfc32(155);
  const bay = HI / 8;
  const transom = Math.round(HI * 0.18);
  ectx.fillStyle = '#000';
  ectx.fillRect(0, 0, HI, HI);
  for (let i = 0; i < 8; i++) {
    const x = i * bay;
    // Sky reflection: bright at the top, dark below, each pane slightly off.
    const tone = r() * 0.2 - 0.1;
    const g = ctx.createLinearGradient(0, 0, 0, HI);
    const top = `rgb(${(150 + tone * 120) | 0},${(172 + tone * 110) | 0},${(190 + tone * 100) | 0})`;
    g.addColorStop(0, top);
    g.addColorStop(0.45, `rgb(${(70 + tone * 60) | 0},${(88 + tone * 60) | 0},${(104 + tone * 60) | 0})`);
    g.addColorStop(1, `rgb(${(36 + tone * 40) | 0},${(44 + tone * 40) | 0},${(54 + tone * 40) | 0})`);
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, bay, HI);
    const lit = r() < 0.3;
    const blinds = r() < 0.35;
    if (blinds) {
      // Lowered blinds in the upper part.
      const depth = HI * (0.25 + r() * 0.4);
      ctx.fillStyle = 'rgba(205,200,188,0.55)';
      for (let y = transom; y < depth; y += 6) ctx.fillRect(x, y, bay, 3);
    }
    if (lit) {
      const warm = r() < 0.6;
      const col = warm ? [255, 214, 150] : [205, 225, 255];
      const a = 0.55 + r() * 0.45;
      const eg = ectx.createLinearGradient(0, 0, 0, HI);
      eg.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${a})`);
      eg.addColorStop(1, `rgba(${col[0] * 0.5},${col[1] * 0.5},${col[2] * 0.5},${a})`);
      ectx.fillStyle = eg;
      ectx.fillRect(x, 0, bay, HI);
      // Ceiling light strips, and the dark shapes of partitions, desks and screens in the room.
      ectx.fillStyle = 'rgba(255,250,235,0.9)';
      ectx.fillRect(x + 6, 6, bay - 12, 5);
      ectx.fillStyle = 'rgba(0,0,0,0.55)';
      ectx.fillRect(x, HI * 0.62, bay, HI * 0.38);
      for (let k = 0; k < 3; k++) {
        const px = x + r() * (bay - 12);
        ectx.fillRect(px, HI * (0.35 + r() * 0.2), 4 + r() * 10, HI * 0.3);
      }
      ectx.fillStyle = 'rgba(0,0,0,0.3)';
      ectx.fillRect(x + r() * bay * 0.5, HI * 0.2, bay * 0.4, HI * 0.15);
      if (blinds) {
        ectx.fillStyle = 'rgba(0,0,0,0.5)';
        for (let y = transom; y < HI * 0.5; y += 6) ectx.fillRect(x, y, bay, 3);
      }
    }
  }
  // Diagonal reflection streaks across the whole tile.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const [x, w, a] of [[90, 40, 0.12], [150, 14, 0.08], [330, 60, 0.07]] as const) {
    const g = ctx.createLinearGradient(x - w, 0, x + w, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, `rgba(255,255,255,${a})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.setTransform(1, 0, -0.5, 1, HI * 0.25, 0);
    ctx.fillRect(x - w, 0, w * 2, HI);
  }
  ctx.restore();
  // Mullions and a transom (dark anodised aluminium, dark in the glow too).
  const frame = (g: Ctx, style: string) => {
    g.fillStyle = style;
    for (let i = 0; i <= 8; i++) g.fillRect(i * bay - 3, 0, 6, HI);
    g.fillRect(0, transom - 3, HI, 6);
    g.fillRect(0, 0, HI, 5);
    g.fillRect(0, HI - 5, HI, 5);
  };
  frame(ctx, '#3a3f46');
  frame(ectx, '#000');
  const h = new Float32Array(HI * HI).fill(0.3);
  carve(h, HI, -0.5, (g) => frame(g, '#000'));
  return { color: c, emissive: e, height: h, bump: 2 };
}

/*
 * Facade atlas: 4 x 4 cells of 256 px (cell = brush tint, see FacadeCell), box-mapped onto the
 * window panels, shopfronts, signs, awnings and rooftop kit that dress the buildings. Cell 0 is
 * the top-left of the canvas. Lit cells glow through the emissive map at night.
 */
const CELL = 256;
const ATLAS = CELL * 4;

type Cell = (g: Ctx, e: Ctx, r: Rand) => void;

function glassGradient(g: Ctx, x: number, y: number, w: number, h: number): void {
  const gr = g.createLinearGradient(0, y, 0, y + h);
  gr.addColorStop(0, '#7d91a3');
  gr.addColorStop(0.5, '#34414e');
  gr.addColorStop(1, '#1b222b');
  g.fillStyle = gr;
  g.fillRect(x, y, w, h);
  // One soft diagonal reflection.
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = 'rgba(255,255,255,0.08)';
  g.beginPath();
  g.moveTo(x + w * 0.2, y);
  g.lineTo(x + w * 0.5, y);
  g.lineTo(x + w * 0.1, y + h);
  g.lineTo(x - w * 0.2, y + h);
  g.fill();
  g.restore();
}

/** Casement window: painted frame all round, a mullion and a transom. `fill` paints the panes. */
function windowFrame(g: Ctx, fill: (x: number, y: number, w: number, h: number) => void, frame = '#d8d4cb'): void {
  g.fillStyle = frame;
  g.fillRect(0, 0, CELL, CELL);
  const m = 18;
  fill(m, m, CELL - m * 2, CELL - m * 2);
  g.fillStyle = frame;
  g.fillRect(CELL / 2 - 5, m, 10, CELL - m * 2);
  g.fillRect(m, 88, CELL - m * 2, 9);
  // Frame shading: dark inner edge, lit sill.
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 3;
  g.strokeRect(m, m, CELL - m * 2, CELL - m * 2);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(0, CELL - 8, CELL, 8);
}

const windowPlain: Cell = (g) => windowFrame(g, (x, y, w, h) => glassGradient(g, x, y, w, h));

const windowBlinds: Cell = (g) =>
  windowFrame(g, (x, y, w, h) => {
    glassGradient(g, x, y, w, h);
    g.fillStyle = 'rgba(214,206,186,0.85)';
    for (let yy = y; yy < y + h * 0.6; yy += 7) g.fillRect(x, yy, w, 4);
  });

function curtains(g: Ctx, x: number, y: number, w: number, h: number, col: [number, number, number]): void {
  for (const side of [0, 1]) {
    const cw = w * 0.3;
    const cx = side ? x + w - cw : x;
    for (let i = 0; i < cw; i++) {
      const k = 0.75 + 0.25 * Math.sin(i * 0.45);
      g.fillStyle = `rgb(${(col[0] * k) | 0},${(col[1] * k) | 0},${(col[2] * k) | 0})`;
      g.fillRect(cx + i, y, 1, h);
    }
  }
}

const windowCurtains: Cell = (g) =>
  windowFrame(g, (x, y, w, h) => {
    glassGradient(g, x, y, w, h);
    curtains(g, x, y, w, h, [150, 58, 48]);
  }, '#ece8df');

const windowShutters: Cell = (g) => {
  g.fillStyle = '#3f5a44';
  g.fillRect(0, 0, CELL, CELL);
  // Two louvred leaves.
  for (const x0 of [8, CELL / 2 + 2]) {
    const w = CELL / 2 - 10;
    g.fillStyle = '#4f6e53';
    g.fillRect(x0, 8, w, CELL - 16);
    for (let y = 20; y < CELL - 20; y += 10) {
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(x0 + 8, y + 6, w - 16, 3);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(x0 + 8, y, w - 16, 2);
    }
  }
  g.fillStyle = 'rgba(0,0,0,0.3)';
  g.fillRect(CELL / 2 - 2, 0, 4, CELL);
};

function litInterior(g: Ctx, e: Ctx, x: number, y: number, w: number, h: number, warm: boolean): void {
  const [a, b] = warm ? ['#f6d28c', '#9a6a34'] : ['#dfe8f6', '#6f7d93'];
  for (const [ctx, k] of [[g, 1], [e, 1]] as const) {
    const gr = ctx.createLinearGradient(0, y, 0, y + h);
    gr.addColorStop(0, a);
    gr.addColorStop(1, b);
    ctx.fillStyle = gr;
    ctx.globalAlpha = k;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
  }
  // A lamp shade and a dark piece of furniture in the room.
  for (const ctx of [g, e]) {
    ctx.fillStyle = 'rgba(30,20,12,0.7)';
    ctx.fillRect(x + w * 0.55, y + h * 0.62, w * 0.35, h * 0.38);
    ctx.fillStyle = warm ? 'rgba(255,240,200,0.9)' : 'rgba(240,248,255,0.9)';
    ctx.fillRect(x + w * 0.2, y + 6, w * 0.25, 10);
  }
}

/** Mask the emissive map with a window frame: frame bars do not glow. */
function frameMask(e: Ctx): void {
  const m = 18;
  e.fillStyle = '#000';
  e.fillRect(0, 0, CELL, m);
  e.fillRect(0, CELL - m, CELL, m);
  e.fillRect(0, 0, m, CELL);
  e.fillRect(CELL - m, 0, m, CELL);
  e.fillRect(CELL / 2 - 5, 0, 10, CELL);
  e.fillRect(0, 88, CELL, 9);
}

const windowLitWarm: Cell = (g, e) => {
  windowFrame(g, (x, y, w, h) => {
    litInterior(g, e, x, y, w, h, true);
    g.fillStyle = 'rgba(214,206,186,0.8)';
    e.fillStyle = 'rgba(0,0,0,0.55)';
    for (let yy = y; yy < y + h * 0.3; yy += 7) {
      g.fillRect(x, yy, w, 4);
      e.fillRect(x, yy, w, 4);
    }
  });
  frameMask(e);
};

const windowLitCool: Cell = (g, e) => {
  windowFrame(g, (x, y, w, h) => {
    litInterior(g, e, x, y, w, h, false);
    curtains(g, x, y, w, h, [200, 190, 160]);
    e.fillStyle = 'rgba(0,0,0,0.6)';
    e.fillRect(x, y, w * 0.3, h);
    e.fillRect(x + w * 0.7, y, w * 0.3, h);
  }, '#ece8df');
  frameMask(e);
};

/** Shopfront (authored for about a 3.2 x 2.6 m opening): aluminium frame, door on the right. */
function shop(g: Ctx, e: Ctx, lit: boolean): void {
  g.fillStyle = '#9aa0a6';
  g.fillRect(0, 0, CELL, CELL);
  const f = 8;
  const doorX = CELL * 0.68;
  const panes: [number, number, number, number][] = [
    [f, f, doorX - f * 1.5, CELL - f * 2 - 26],
    [doorX + f / 2, f, CELL - doorX - f * 1.5, CELL - f * 2],
  ];
  for (const [x, y, w, h] of panes) {
    if (lit) {
      litInterior(g, e, x, y, w, h, true);
      // Shelves of goods.
      for (let sy = y + h * 0.35; sy < y + h - 10; sy += 28) {
        for (let sx = x + 6; sx < x + w - 10; sx += 12) {
          const hue = (sx * 37 + sy * 11) % 360;
          g.fillStyle = `hsl(${hue},55%,50%)`;
          g.fillRect(sx, sy - 12, 9, 12);
          e.fillStyle = `hsla(${hue},55%,40%,0.8)`;
          e.fillRect(sx, sy - 12, 9, 12);
        }
        g.fillStyle = '#5a4a3a';
        g.fillRect(x, sy, w, 3);
      }
    } else {
      glassGradient(g, x, y, w, h);
      g.fillStyle = 'rgba(10,12,16,0.45)';
      g.fillRect(x, y + h * 0.4, w, h * 0.6);
    }
  }
  // Stall riser under the display window.
  g.fillStyle = '#4b4f55';
  g.fillRect(f, CELL - f - 26, doorX - f * 1.5, 26);
  // Door handle.
  g.fillStyle = '#d6d8dc';
  g.fillRect(doorX + 12, CELL * 0.5, 6, 30);
}

const shopDark: Cell = (g, e) => shop(g, e, false);
const shopLit: Cell = (g, e) => shop(g, e, true);

/** Shop sign authored for a 5:1 board: drawn wide, then squeezed into the square cell. */
function sign(text: string, bg: string, fg: string, glow: string): Cell {
  return (g, e) => {
    const W = CELL * 5;
    for (const [ctx, isGlow] of [[g, false], [e, true]] as const) {
      const [wc, w] = canvas(W);
      wc.height = CELL;
      w.fillStyle = isGlow ? 'rgba(0,0,0,1)' : bg;
      w.fillRect(0, 0, W, CELL);
      if (isGlow) {
        w.fillStyle = bg;
        w.globalAlpha = 0.25;
        w.fillRect(0, 0, W, CELL);
        w.globalAlpha = 1;
      }
      w.strokeStyle = isGlow ? glow : fg;
      w.lineWidth = 14;
      w.strokeRect(14, 14, W - 28, CELL - 28);
      w.fillStyle = isGlow ? glow : fg;
      w.font = `bold ${CELL * 0.6}px Impact, "Arial Black", sans-serif`;
      w.textAlign = 'center';
      w.textBaseline = 'middle';
      w.fillText(text, W / 2, CELL * 0.54, W - 90);
      ctx.drawImage(wc, 0, 0, W, CELL, 0, 0, CELL, CELL);
    }
  };
}

function awning(a: string, b: string): Cell {
  return (g) => {
    const n = 8;
    for (let i = 0; i < n; i++) {
      g.fillStyle = i % 2 ? b : a;
      g.fillRect((i * CELL) / n, 0, CELL / n, CELL);
    }
    // Weathered: darker towards the bottom, a hint of fabric weave.
    const gr = g.createLinearGradient(0, 0, 0, CELL);
    gr.addColorStop(0, 'rgba(255,255,255,0.08)');
    gr.addColorStop(1, 'rgba(0,0,0,0.3)');
    g.fillStyle = gr;
    g.fillRect(0, 0, CELL, CELL);
    g.fillStyle = 'rgba(0,0,0,0.05)';
    for (let y = 0; y < CELL; y += 3) g.fillRect(0, y, CELL, 1);
  };
}

/** Rooftop kit: a condenser fan grille in a louvred casing. */
const grille: Cell = (g) => {
  g.fillStyle = '#b9bcbf';
  g.fillRect(0, 0, CELL, CELL);
  g.fillStyle = 'rgba(0,0,0,0.3)';
  for (let y = 10; y < CELL; y += 12) g.fillRect(8, y, CELL - 16, 4);
  const m = CELL / 2;
  g.fillStyle = '#2b2d30';
  g.beginPath();
  g.arc(m, m, 96, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#8f9397';
  g.lineWidth = 3;
  for (let rr = 20; rr <= 96; rr += 13) {
    g.beginPath();
    g.arc(m, m, rr, 0, Math.PI * 2);
    g.stroke();
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.beginPath();
    g.moveTo(m, m);
    g.lineTo(m + Math.cos(a) * 96, m + Math.sin(a) * 96);
    g.stroke();
  }
  g.fillStyle = '#555';
  g.beginPath();
  g.arc(m, m, 14, 0, Math.PI * 2);
  g.fill();
};

/** Roller shutter over a closed shop or a service door. */
const rollerShutter: Cell = (g, _e, r) => {
  for (let y = 0; y < CELL; y += 10) {
    g.fillStyle = '#8c9095';
    g.fillRect(0, y, CELL, 10);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(0, y, CELL, 2);
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(0, y + 8, CELL, 2);
  }
  // Grime and a scrawled tag.
  const gr = g.createLinearGradient(0, 0, 0, CELL);
  gr.addColorStop(0, 'rgba(0,0,0,0)');
  gr.addColorStop(1, 'rgba(40,30,20,0.35)');
  g.fillStyle = gr;
  g.fillRect(0, 0, CELL, CELL);
  g.strokeStyle = 'rgba(40,40,160,0.7)';
  g.lineWidth = 7;
  g.lineCap = 'round';
  g.beginPath();
  let x = 40;
  let y = 150;
  g.moveTo(x, y);
  for (let i = 0; i < 9; i++) {
    x += 14 + r() * 10;
    y = 130 + r() * 50;
    g.lineTo(x, y);
  }
  g.stroke();
};

const ATLAS_CELLS: Cell[] = [
  windowPlain,
  windowBlinds,
  windowCurtains,
  windowShutters,
  windowLitWarm,
  windowLitCool,
  shopDark,
  shopLit,
  sign('PHARMACY', '#1d6b3a', '#f2f7ef', '#7dffa8'),
  sign('HOTEL', '#20233a', '#ffcf5a', '#ffd76e'),
  sign('BAR & GRILL', '#6b1a1a', '#ffe4c8', '#ff6a4d'),
  sign('LIQUOR', '#1c3f73', '#f0f4ff', '#6fb8ff'),
  awning('#9b2a24', '#e9e2d2'),
  awning('#2f5b3a', '#e5dcc2'),
  grille,
  rollerShutter,
];

function facadeAtlas(): Painted {
  const [c, ctx] = canvas(ATLAS);
  const [e, ectx] = canvas(ATLAS);
  ectx.fillStyle = '#000';
  ectx.fillRect(0, 0, ATLAS, ATLAS);
  const r = sfc32(166);
  ATLAS_CELLS.forEach((cell, i) => {
    const x = (i % 4) * CELL;
    const y = Math.floor(i / 4) * CELL;
    for (const g of [ctx, ectx]) {
      g.save();
      g.translate(x, y);
      g.beginPath();
      g.rect(0, 0, CELL, CELL);
      g.clip();
    }
    cell(ctx, ectx, r);
    ctx.restore();
    ectx.restore();
  });
  return { color: c, emissive: e };
}

function dev(): OffscreenCanvas {
  const [c, ctx] = canvas();
  ctx.fillStyle = '#b8b0a4';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = '#c9c2b6';
  ctx.fillRect(0, 0, SIZE / 2, SIZE / 2);
  ctx.fillRect(SIZE / 2, SIZE / 2, SIZE / 2, SIZE / 2);
  ctx.strokeStyle = 'rgba(80,80,80,0.35)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 8; i++) {
    const p = (i * SIZE) / 8;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, SIZE);
    ctx.moveTo(0, p);
    ctx.lineTo(SIZE, p);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(220,120,40,0.45)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, SIZE - 2, SIZE - 2);
  return c;
}

function paintTex(): OffscreenCanvas {
  const [c, ctx] = canvas(64);
  const r = sfc32(99);
  paint(ctx, () => {
    const v = 225 + r() * 25;
    return [v, v, v * 0.97];
  });
  return c;
}

/*
 * Car textures are box-mapped (each face spans the whole texture, canvas top = face top) and
 * near-white so the brush palette supplies the color.
 */

function carPaint(): OffscreenCanvas {
  const [c, ctx] = canvas(128);
  const r = sfc32(111);
  const n = [makeNoise(r, 4), makeNoise(r, 16)];
  paint(ctx, (u, v) => {
    const up = 1 - v;
    // Darker towards the sills, a soft sky highlight along the shoulder line, faint flake.
    const grad = 0.8 + 0.2 * Math.min(1, up * 1.4);
    const band = Math.exp(-(((up - 0.78) / 0.07) ** 2)) * 0.1;
    const f = (fbm(n, u, v) - 0.5) * 0.05 + (r() - 0.5) * 0.035;
    const k = (grad + band + f) * 245;
    return [clamp255(k), clamp255(k), clamp255(k + 2)];
  });
  return c;
}

function carGlass(): OffscreenCanvas {
  const [c, ctx] = canvas(128);
  const S = 128;
  const sky = ctx.createLinearGradient(0, 0, 0, S);
  sky.addColorStop(0, '#6f8193');
  sky.addColorStop(0.45, '#2c3642');
  sky.addColorStop(1, '#161b22');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, S, S);
  // Diagonal reflection streaks.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const [x, w, a] of [[34, 18, 0.14], [62, 7, 0.1]] as const) {
    const g = ctx.createLinearGradient(x - w, 0, x + w, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, `rgba(255,255,255,${a})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.setTransform(1, 0, -0.6, 1, 0.6 * S * 0.5, 0);
    ctx.fillRect(x - w, 0, w * 2, S);
  }
  ctx.restore();
  // Rubber seal.
  ctx.strokeStyle = '#0b0b0c';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, S - 6, S - 6);
  return c;
}

function carWheel(): OffscreenCanvas {
  const [c, ctx] = canvas(128);
  const r = sfc32(122);
  const S = 128;
  const m = S / 2;
  // Wheel-arch shadow.
  ctx.fillStyle = '#0c0c0c';
  ctx.fillRect(0, 0, S, S);
  // Tire with speckled tread.
  ctx.fillStyle = '#202020';
  ctx.beginPath();
  ctx.arc(m, m, m - 2, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 400; i++) {
    const a = r() * Math.PI * 2;
    const d = 40 + r() * 21;
    const k = 24 + r() * 22;
    ctx.fillStyle = `rgb(${k | 0},${k | 0},${k | 0})`;
    ctx.fillRect(m + Math.cos(a) * d, m + Math.sin(a) * d, 1.5, 1.5);
  }
  // Rim.
  const rim = ctx.createRadialGradient(m - 8, m - 8, 4, m, m, 40);
  rim.addColorStop(0, '#d6d8dc');
  rim.addColorStop(0.7, '#9a9da3');
  rim.addColorStop(1, '#5e6166');
  ctx.fillStyle = rim;
  ctx.beginPath();
  ctx.arc(m, m, 38, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#3a3c40';
  ctx.lineWidth = 2;
  ctx.stroke();
  // Spoke gaps.
  ctx.fillStyle = '#18191b';
  for (let i = 0; i < 5; i++) {
    const a0 = (i / 5) * Math.PI * 2 - Math.PI / 2 + 0.3;
    const a1 = a0 + 0.62;
    ctx.beginPath();
    ctx.arc(m, m, 32, a0, a1);
    ctx.arc(m, m, 14, a1 - 0.1, a0 + 0.1, true);
    ctx.closePath();
    ctx.fill();
  }
  // Center cap and lug ring.
  ctx.fillStyle = '#b4b7bc';
  ctx.beginPath();
  ctx.arc(m, m, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#4a4c50';
  ctx.beginPath();
  ctx.arc(m, m, 3, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

function carTrim(): OffscreenCanvas {
  const [c, ctx] = canvas(64);
  const r = sfc32(133);
  paint(ctx, (u, v) => {
    // Bevel: lit top edge, shaded bottom edge, so lenses and plates read as separate parts.
    const edge = Math.min(u, 1 - u, v, 1 - v);
    let k = 225 + (r() - 0.5) * 10;
    if (edge < 0.1) k += v < 0.5 ? 25 : -60;
    return [clamp255(k), clamp255(k), clamp255(k)];
  });
  return c;
}

/** Frosted lamp glass (it glows through the material's emissive at night). */
function lampGlass(): OffscreenCanvas {
  const [c, ctx] = canvas(16);
  ctx.fillStyle = '#ece6d4';
  ctx.fillRect(0, 0, 16, 16);
  return c;
}

/** Murky river water: soft ripples (the material scrolls it and makes it see-through). */
function water(): OffscreenCanvas {
  const [c, ctx] = canvas();
  const r = sfc32(161);
  const n = [makeNoise(r, 4), makeNoise(r, 9), makeNoise(r, 22)];
  paint(ctx, (u, v) => {
    const f = fbm(n, u, v);
    const glint = Math.max(0, f - 0.62) * 260;
    return [clamp255(52 + f * 30 + glint), clamp255(84 + f * 34 + glint), clamp255(92 + f * 30 + glint)];
  });
  return c;
}

function grass(): OffscreenCanvas {
  const [c, ctx] = canvas();
  const r = sfc32(171);
  const n = [makeNoise(r, 5), makeNoise(r, 14), makeNoise(r, 60)];
  paint(ctx, (u, v) => {
    const f = fbm(n, u, v);
    const blade = r() * 26 - 13;
    return [clamp255(70 + f * 40 + blade * 0.6), clamp255(104 + f * 50 + blade), clamp255(46 + f * 24 + blade * 0.4)];
  });
  return c;
}

const PAINTERS: Record<number, () => Painted | OffscreenCanvas> = {
  [Material.Water]: water,
  [Material.Grass]: grass,
  [Material.LampGlow]: lampGlass,
  [Material.CarPaint]: carPaint,
  [Material.CarGlass]: carGlass,
  [Material.CarWheel]: carWheel,
  [Material.CarTrim]: carTrim,
  [Material.Paint]: paintTex,
  [Material.Concrete]: concrete,
  [Material.Plaster]: plaster,
  [Material.Brick]: brick,
  [Material.Asphalt]: asphalt,
  [Material.Sidewalk]: sidewalk,
  [Material.Crate]: crate,
  [Material.Metal]: metal,
  [Material.Dev]: dev,
  [Material.Wood]: wood,
  [Material.Stone]: stone,
  [Material.RoofTar]: roofTar,
  [Material.Facade]: facadeAtlas,
  [Material.CurtainWall]: curtainWall,
};

/** Tiny stand-in for materials whose look comes from elsewhere (window glass, drawn by BreakablesRenderer). */
function blank(): OffscreenCanvas {
  const [c, ctx] = canvas(4);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 4, 4);
  return c;
}

/** Materials that get a normal map / an emissive map (known up front, so shaders never change). */
export const NORMAL_MAPPED: ReadonlySet<number> = new Set([
  Material.Concrete,
  Material.Plaster,
  Material.Brick,
  Material.Asphalt,
  Material.Sidewalk,
  Material.Metal,
  Material.Wood,
  Material.Stone,
  Material.RoofTar,
  Material.CurtainWall,
]);
export const EMISSIVE_MAPPED: ReadonlySet<number> = new Set([Material.Facade, Material.CurtainWall]);

/** RGBA pixels, bottom row first (ready for upload as a texture with v = 0 at the bottom). */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Painted maps for one material. */
export interface PaintedMaps {
  material: number;
  map: Pixels;
  normalMap?: Pixels;
  emissiveMap?: Pixels;
}

function pixels(c: OffscreenCanvas): Pixels {
  const { width, height } = c;
  const src = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, width, height).data;
  const data = new Uint8Array(src.length);
  const row = width * 4;
  for (let y = 0; y < height; y++) data.set(src.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
  return { width, height, data };
}

export function paintMaterial(material: number): PaintedMaps {
  const painted = (PAINTERS[material] ?? blank)();
  const p: Painted = painted instanceof OffscreenCanvas ? { color: painted } : painted;
  const out: PaintedMaps = { material, map: pixels(p.color) };
  if (p.height) out.normalMap = pixels(heightToNormal(p.height, p.color.width, p.bump ?? 2));
  if (p.emissive) out.emissiveMap = pixels(p.emissive);
  return out;
}

/** Paint order: what fills most of the screen first. */
export const PAINT_ORDER: readonly number[] = [
  Material.Asphalt,
  Material.Sidewalk,
  Material.Concrete,
  Material.Plaster,
  Material.Brick,
  Material.Facade,
  Material.CurtainWall,
  Material.Stone,
  Material.RoofTar,
  Material.Metal,
  Material.Wood,
  Material.Crate,
  Material.Grass,
  Material.Water,
  Material.CarPaint,
  Material.CarGlass,
  Material.CarWheel,
  Material.CarTrim,
  Material.LampGlow,
  Material.Paint,
  Material.Dev,
  Material.Glass,
];
