import { CHUNK } from '../core/config';
import { fnv1a } from '../core/rng';
import { DISTRICT_NAMES, NAV_RES, NavFlag } from '../world/gen/ChunkData';
import { generateChunk } from '../world/gen/generateChunk';
import { drawChunkTopdown } from '../ui/minimapRaster';

/** Dev-only top-down map of a 9x9 chunk region, for iterating on layouts without playing. */

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
      drawChunkTopdown(ctx, d, PX, ox, oz);
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
      ctx.fillStyle = '#f33';
      for (let s = 0; s < d.pickups.length; s += 3) {
        ctx.fillRect(ox + (d.pickups[s] - cx * CHUNK) * PX - 3, oz + (d.pickups[s + 2] - cz * CHUNK) * PX - 3, 6, 6);
      }
      if (d.hasEncounter) encounters++;
      ctx.fillStyle = d.hasEncounter ? '#ff8a7a' : '#fff';
      ctx.font = '11px monospace';
      ctx.fillText(`${cx},${cz} ${DISTRICT_NAMES[d.district]} L${d.level}${d.hasEncounter ? ' ⚔' : ''}`, ox + 4, oz + 12);
    }
  }
  $('info').textContent = `avg gen ${(totalMs / (SPAN * SPAN)).toFixed(1)} ms · ${encounters} encounters · yellow = spawn slots, magenta = perches, red = health packs`;
}

for (const id of ['seed', 'cx', 'cz', 'nav']) $(id).addEventListener('change', draw);
draw();
