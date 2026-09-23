import { weighted } from '../../core/rng';
import { rd, rect, rw, type GenContext, type Rect } from './genContext';

export type ParcelKind = 'building' | 'courtyard' | 'yard' | 'lot';

export interface Parcel extends Rect {
  kind: ParcelKind;
}

/** Recursive BSP split of the lot into parcels, sometimes leaving an alley in the cut. */
export function splitLot(ctx: GenContext, lot: Rect): { parcels: Parcel[]; alleys: Rect[] } {
  const parcels: Parcel[] = [];
  const alleys: Rect[] = [];
  const { maxParcel, minParcel, alleyChance } = ctx.district;
  const r = ctx.r;

  const split = (a: Rect, depth: number) => {
    const W = rw(a);
    const D = rd(a);
    if ((W <= maxParcel && D <= maxParcel) || depth > 8) {
      parcels.push({ ...a, kind: 'lot' });
      return;
    }
    const alongX = W > D ? true : W < D ? false : r() < 0.5;
    const len = alongX ? W : D;
    let alley = r() < alleyChance ? 3 + Math.floor(r() * 2) : 0;
    if (len < 2 * minParcel + alley) alley = 0;
    if (len < 2 * minParcel) {
      parcels.push({ ...a, kind: 'lot' });
      return;
    }
    const lo = minParcel;
    const hi = len - minParcel - alley;
    let t = Math.round(len * (0.35 + r() * 0.3));
    t = Math.max(lo, Math.min(hi, t));
    if (alongX) {
      const cut = a.x0 + t;
      split(rect(a.x0, a.z0, cut, a.z1), depth + 1);
      if (alley) alleys.push(rect(cut, a.z0, cut + alley, a.z1));
      split(rect(cut + alley, a.z0, a.x1, a.z1), depth + 1);
    } else {
      const cut = a.z0 + t;
      split(rect(a.x0, a.z0, a.x1, cut), depth + 1);
      if (alley) alleys.push(rect(a.x0, cut, a.x1, cut + alley));
      split(rect(a.x0, cut + alley, a.x1, a.z1), depth + 1);
    }
  };
  split(lot, 0);
  return { parcels, alleys };
}

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;

/**
 * Assign parcel kinds by district weights, then enforce the open-space quota: at least 25% of
 * the lot stays walkable open ground, including one open parcel of 12x12 m or more (the arena).
 * Parcels that overlap stairs/ramps (`keep`) are never built on.
 */
export function typeParcels(ctx: GenContext, parcels: Parcel[], alleys: Rect[], keep: Rect[], lotArea: number): void {
  const w = ctx.district.weights;
  const items: [ParcelKind, number][] = [
    ['building', w.building],
    ['courtyard', w.courtyard],
    ['yard', w.yard],
    ['lot', w.lot],
  ];
  for (const p of parcels) {
    p.kind = weighted(ctx.r, items);
    if (p.kind === 'building' && keep.some((k) => overlaps(k, p))) p.kind = 'lot';
    if (p.kind === 'courtyard' && (rw(p) < 9 || rd(p) < 9)) p.kind = 'lot';
  }
  const area = (p: Rect) => rw(p) * rd(p);
  const openArea = () =>
    alleys.reduce((s, a) => s + area(a), 0) + parcels.filter((p) => p.kind !== 'building').reduce((s, p) => s + area(p), 0);

  // Arena: at least one open parcel of 12x12 or more.
  const hasArena = parcels.some((p) => p.kind !== 'building' && rw(p) >= 12 && rd(p) >= 12);
  if (!hasArena) {
    const big = parcels.filter((p) => rw(p) >= 12 && rd(p) >= 12).sort((a, b) => area(b) - area(a))[0];
    if (big) big.kind = ctx.r() < 0.5 ? 'lot' : 'yard';
  }
  // Open-space quota: convert the smallest buildings until satisfied.
  const byArea = parcels.filter((p) => p.kind === 'building').sort((a, b) => area(a) - area(b));
  while (openArea() < lotArea * 0.25 && byArea.length) byArea.shift()!.kind = 'lot';
}
