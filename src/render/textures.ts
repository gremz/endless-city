import * as THREE from 'three';
import { sfc32, type Rand } from '../core/rng';
import { Material } from '../world/gen/ChunkData';

/** Procedural canvas textures, so the game ships with zero art assets. */

const SIZE = 256;

function canvas(size = SIZE): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  return [c, ctx];
}

/** Tileable value noise sampled on a coarse lattice with smooth interpolation. */
function makeNoise(r: Rand, cells: number): (x: number, y: number) => number {
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const at = (x: number, y: number) => g[((y % cells) + cells) % cells * cells + (((x % cells) + cells) % cells)];
  return (x: number, y: number) => {
    const fx = x * cells;
    const fy = y * cells;
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
function paint(ctx: CanvasRenderingContext2D, fn: (u: number, v: number, x: number, y: number) => [number, number, number]) {
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

function concrete(): HTMLCanvasElement {
  const [c, ctx] = canvas();
  const r = sfc32(11);
  const n = [makeNoise(r, 4), makeNoise(r, 8), makeNoise(r, 16), makeNoise(r, 64)];
  paint(ctx, (u, v) => {
    const f = fbm(n, u, v);
    const s = r() * 14 - 7;
    const base = 150 + (f - 0.5) * 60 + s;
    return [clamp255(base), clamp255(base - 2), clamp255(base - 6)];
  });
  // Formwork panel seams.
  ctx.strokeStyle = 'rgba(40,40,40,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, SIZE / 2);
  ctx.lineTo(SIZE, SIZE / 2);
  ctx.moveTo(SIZE / 2, 0);
  ctx.lineTo(SIZE / 2, SIZE);
  ctx.stroke();
  // Tie holes.
  ctx.fillStyle = 'rgba(50,50,50,0.4)';
  for (const [x, y] of [[32, 32], [96, 32], [160, 32], [224, 32], [32, 160], [96, 160], [160, 160], [224, 160]]) {
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

function plaster(): HTMLCanvasElement {
  const [c, ctx] = canvas();
  const r = sfc32(22);
  const n = [makeNoise(r, 3), makeNoise(r, 6), makeNoise(r, 12), makeNoise(r, 48)];
  const stain = makeNoise(r, 5);
  paint(ctx, (u, v) => {
    const f = fbm(n, u, v);
    const s = r() * 10 - 5;
    const st = Math.max(0, stain(u, v) - 0.55) * 90;
    return [clamp255(214 + (f - 0.5) * 50 + s - st), clamp255(190 + (f - 0.5) * 45 + s - st * 1.1), clamp255(150 + (f - 0.5) * 40 + s - st * 1.3)];
  });
  // Hairline cracks.
  ctx.strokeStyle = 'rgba(90,70,50,0.35)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    let x = r() * SIZE;
    let y = r() * SIZE;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 8; k++) {
      x += (r() - 0.5) * 24;
      y += r() * 14;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return c;
}

function brick(): HTMLCanvasElement {
  const [c, ctx] = canvas();
  const r = sfc32(33);
  ctx.fillStyle = '#8b8378';
  ctx.fillRect(0, 0, SIZE, SIZE);
  const bw = 32;
  const bh = 16;
  for (let row = 0; row < SIZE / bh; row++) {
    const off = row % 2 ? bw / 2 : 0;
    for (let col = -1; col < SIZE / bw + 1; col++) {
      const x = col * bw + off;
      const y = row * bh;
      const k = r();
      const red = 130 + k * 50;
      ctx.fillStyle = `rgb(${red | 0},${(55 + k * 30) | 0},${(40 + k * 20) | 0})`;
      ctx.fillRect(x + 1.5, y + 1.5, bw - 3, bh - 3);
      ctx.fillStyle = `rgba(0,0,0,${0.08 + r() * 0.1})`;
      ctx.fillRect(x + 1.5, y + bh - 5, bw - 3, 3.5);
    }
  }
  const n = makeNoise(r, 32);
  const img = ctx.getImageData(0, 0, SIZE, SIZE);
  for (let i = 0; i < img.data.length; i += 4) {
    const p = i / 4;
    const f = (n((p % SIZE) / SIZE, Math.floor(p / SIZE) / SIZE) - 0.5) * 30;
    img.data[i] = clamp255(img.data[i] + f);
    img.data[i + 1] = clamp255(img.data[i + 1] + f);
    img.data[i + 2] = clamp255(img.data[i + 2] + f);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function asphalt(): HTMLCanvasElement {
  const [c, ctx] = canvas();
  const r = sfc32(44);
  const n = [makeNoise(r, 4), makeNoise(r, 16), makeNoise(r, 64)];
  paint(ctx, (u, v) => {
    const f = fbm(n, u, v);
    const s = r() < 0.08 ? 25 : r() * 12 - 6;
    const base = 64 + (f - 0.5) * 30 + s;
    return [clamp255(base), clamp255(base), clamp255(base + 3)];
  });
  ctx.strokeStyle = 'rgba(20,20,20,0.5)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 3; i++) {
    let x = r() * SIZE;
    let y = r() * SIZE;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 12; k++) {
      x += (r() - 0.5) * 30;
      y += (r() - 0.5) * 30;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return c;
}

function sidewalk(): HTMLCanvasElement {
  const [c, ctx] = canvas();
  const r = sfc32(55);
  const n = [makeNoise(r, 8), makeNoise(r, 32)];
  paint(ctx, (u, v) => {
    const f = fbm(n, u, v);
    const base = 168 + (f - 0.5) * 30 + r() * 10 - 5;
    return [clamp255(base), clamp255(base - 1), clamp255(base - 4)];
  });
  const t = SIZE / 4;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      ctx.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,255,255'},${r() * 0.06})`;
      ctx.fillRect(i * t, j * t, t, t);
    }
  }
  ctx.strokeStyle = 'rgba(60,60,60,0.55)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath();
    ctx.moveTo(i * t, 0);
    ctx.lineTo(i * t, SIZE);
    ctx.moveTo(0, i * t);
    ctx.lineTo(SIZE, i * t);
    ctx.stroke();
  }
  return c;
}

function woodBase(ctx: CanvasRenderingContext2D, r: Rand, horizontal: boolean, tone = 1) {
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

function crate(): HTMLCanvasElement {
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

function wood(): HTMLCanvasElement {
  const [c, ctx] = canvas();
  const r = sfc32(77);
  woodBase(ctx, r, true, 0.9);
  ctx.fillStyle = 'rgba(30,18,8,0.6)';
  for (let i = 1; i < 8; i++) ctx.fillRect(0, (i * SIZE) / 8 - 1, SIZE, 2);
  return c;
}

function metal(): HTMLCanvasElement {
  const [c, ctx] = canvas();
  const r = sfc32(88);
  const n = [makeNoise(r, 4), makeNoise(r, 16)];
  const rust = makeNoise(r, 6);
  paint(ctx, (u, v) => {
    // Corrugation: vertical ridges.
    const ridge = Math.sin(u * Math.PI * 2 * 12);
    const f = fbm(n, u, v);
    const base = 200 + ridge * 28 + (f - 0.5) * 20;
    const rr = Math.max(0, rust(u, v) - 0.62) * 300;
    return [clamp255(base - rr * 0.2), clamp255(base - rr * 0.55), clamp255(base - rr * 0.8)];
  });
  return c;
}

function dev(): HTMLCanvasElement {
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

function paintTex(): HTMLCanvasElement {
  const [c, ctx] = canvas(64);
  const r = sfc32(99);
  paint(ctx, () => {
    const v = 225 + r() * 25;
    return [v, v, v * 0.97];
  });
  return c;
}

const PAINTERS: Record<number, () => HTMLCanvasElement> = {
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
};

export function makeMaterialTexture(material: number, anisotropy: number): THREE.CanvasTexture {
  const painter = PAINTERS[material] ?? concrete;
  const tex = new THREE.CanvasTexture(painter());
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}
