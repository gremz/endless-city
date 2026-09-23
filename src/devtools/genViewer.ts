import { CHUNK } from '../core/config';
import { fnv1a } from '../core/rng';
import { BRUSH_STRIDE, DISTRICT_NAMES, Material, NAV_RES, NavFlag, wordContents, wordMaterial } from '../world/gen/ChunkData';
import { generateChunk } from '../world/gen/generateChunk';
import { Contents } from '../physics/brush';

/** Dev-only top-down map of a 9x9 chunk region, for iterating on layouts without playing. */

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
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('map');
const ctx = canvas.getContext('2d')!;
const SPAN = 9;
const PX = 1.6; // pixels per meter

function draw(): void {
  const seedText = $<HTMLInputElement>('seed').value;
  const seed = /^\d+$/.test(seedText) ? Number(seedText) >>> 0 : fnv1a(seedText);
  const ccx = Number($<HTMLInputElement>('cx').value) | 0;
  const ccz = Number($<HTMLInputElement>('cz').value) | 0;
  const showNav = $<HTMLInputElement>('nav').checked;
  const size = SPAN * CHUNK * PX;
  canvas.width = canvas.height = size;
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, size, size);
  let totalMs = 0;
  let encounters = 0;
  const half = Math.floor(SPAN / 2);
  for (let dz = -half; dz <= half; dz++) {
    for (let dx = -half; dx <= half; dx++) {
      const cx = ccx + dx;
      const cz = ccz + dz;
      const d = generateChunk(seed, cx, cz);
      totalMs += d.genMs;
      const ox = (dx + half) * CHUNK * PX;
      const oz = (dz + half) * CHUNK * PX;
      // Brushes sorted by top height so taller things draw last.
      const order: number[] = [];
      for (let i = 0; i < d.brushes.length; i += BRUSH_STRIDE) order.push(i);
      order.sort((a, b) => d.brushes[a + 4] - d.brushes[b + 4]);
      for (const o of order) {
        const c = wordContents(d.brushes[o + 6]);
        if (!(c & Contents.VISIBLE)) continue;
        const h = d.brushes[o + 4] / 100;
        ctx.fillStyle = COLORS[wordMaterial(d.brushes[o + 6])] ?? '#f0f';
        ctx.globalAlpha = 0.55 + Math.min(0.45, h / 20);
        ctx.fillRect(ox + (d.brushes[o] / 100) * PX, oz + (d.brushes[o + 2] / 100) * PX, ((d.brushes[o + 3] - d.brushes[o]) / 100) * PX, ((d.brushes[o + 5] - d.brushes[o + 2]) / 100) * PX);
      }
      ctx.globalAlpha = 1;
      if (showNav) {
        const cell = (CHUNK / NAV_RES) * PX;
        for (let j = 0; j < NAV_RES; j++) {
          for (let i = 0; i < NAV_RES; i++) {
            const f = d.navFlags[j * NAV_RES + i];
            if (!(f & NavFlag.Walkable)) continue;
            ctx.fillStyle = f & NavFlag.Reachable ? (f & (NavFlag.CoverFull | NavFlag.CoverHalf) ? 'rgba(80,160,255,0.35)' : 'rgba(80,255,120,0.22)') : 'rgba(255,60,60,0.45)';
            ctx.fillRect(ox + i * cell, oz + j * cell, cell, cell);
          }
        }
      }
      ctx.fillStyle = '#ff4';
      for (let s = 0; s < d.spawns.length; s += 3) {
        ctx.fillRect(ox + (d.spawns[s] - cx * CHUNK) * PX - 2, oz + (d.spawns[s + 2] - cz * CHUNK) * PX - 2, 4, 4);
      }
      ctx.fillStyle = '#f0f';
      for (let s = 0; s < d.perches.length; s += 3) {
        ctx.fillRect(ox + (d.perches[s] - cx * CHUNK) * PX - 2, oz + (d.perches[s + 2] - cz * CHUNK) * PX - 2, 4, 4);
      }
      if (d.hasEncounter) encounters++;
      ctx.fillStyle = d.hasEncounter ? '#ff8a7a' : '#fff';
      ctx.font = '11px monospace';
      ctx.fillText(`${cx},${cz} ${DISTRICT_NAMES[d.district]} L${d.level}${d.hasEncounter ? ' ⚔' : ''}`, ox + 4, oz + 12);
    }
  }
  $('info').textContent = `avg gen ${(totalMs / (SPAN * SPAN)).toFixed(1)} ms · ${encounters} encounters · yellow = spawn slots, magenta = perches`;
}

for (const id of ['seed', 'cx', 'cz', 'nav']) $(id).addEventListener('change', draw);
draw();
