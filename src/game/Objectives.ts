import { WARN_TIME } from '../ai/hostage';
import { CHUNK } from '../core/config';
import type { SimEvent } from '../core/events';
import type { Vec3 } from '../core/math';
import type { Actor } from '../sim/Actor';
import { priceOf, recommendUpgrade, type BuyItem } from '../sim/buy';
import { itemName } from '../ui/BuyMenu';
import { NAV_CELL, NAV_RES, type ChunkData } from '../world/gen/ChunkData';
import { NAV_LINK_STRIDE, spanColumns } from '../world/gen/navBake';

/**
 * The guided opening, which ends once the player has driven to and cleared a second area:
 * ambush (clear the pair ahead) → loot (grab the MP9, draw it) → car (get in one) → hunt (clear
 * the next area) → wrapup (a moment in the new buy zone) → upgrade (what they can afford, if
 * anything) → briefing (how the rest of the city works) → done (no objective any more).
 */
export type ObjectiveStep = 'ambush' | 'loot' | 'car' | 'hunt' | 'wrapup' | 'upgrade' | 'briefing' | 'done';
export const OBJECTIVE_STEPS: readonly ObjectiveStep[] = ['ambush', 'loot', 'car', 'hunt', 'wrapup', 'upgrade', 'briefing', 'done'];

/** The closing briefing: how the city works from here on, one card at a time. */
export const BRIEFING: readonly { title: string; sub: string }[] = [
  { title: 'Clear areas to take the city', sub: '⚔ on the radar marks a squad · cleared areas become buy zones and respawn points' },
  { title: 'Danger rises with distance', sub: 'The number by ⚔ is its danger level · further from spawn: tougher squads, bigger pay' },
  { title: "Dying isn't the end", sub: 'You come back at the nearest cleared area · your gear waits where you fell (the bag on the radar)' },
  { title: 'Night pays more', sub: 'After dark bots see half as far and kills pay 25% more · a flashlight (L) gives you away' },
  { title: 'Plan your route', sub: 'M opens the city map · the game saves after every clear' },
];

export interface ObjectiveView {
  title: string;
  sub: string;
  /** Where the waypoint goes, or null for none. */
  target: Vec3 | null;
  /** Buy menu item to point out. */
  highlight: BuyItem | null;
  /** Small heading above the title (the briefing's "1/5"), shown instead of the new-objective intro. */
  kicker?: string;
  /** Running out of time: the line turns red. */
  urgent?: boolean;
}

/** What the objectives look at, gathered by the game each frame. */
export interface ObjectiveContext {
  /** Sim time. */
  now: number;
  player: Actor;
  /** In a buy zone and out of combat: buying works right now. */
  inBuyZone: boolean;
  inCombat: boolean;
  openingCleared: boolean;
  /** Where the opening's hostage kneels, while he's alive, or null. */
  captive: Vec3 | null;
  /** Living bots in the opening area, and its centre (the fallback waypoint). */
  openingBots: readonly Vec3[];
  openingCenter: Vec3;
  /** Nearest MP9 lying on the ground within reach of the tour, or null. */
  mp9: Vec3 | null;
  /** Nearest free driveable car within reach of the tour, or null. */
  car: Vec3 | null;
  /** Nearest uncleared encounter area, or null. */
  nextArea: { pos: Vec3; level: number } | null;
}

/** Seconds the upgrade prompt stays up if the player ignores it. */
const UPGRADE_TIME = 45;
/** Seconds after the last clear to wait for the fight to die down before offering an upgrade. */
const WRAPUP_TIME = 20;
/** Seconds each briefing card stays up, and the pause before the next (counted only out of combat). */
const CARD_TIME = 8;
const CARD_GAP = 1.5;

export class Objectives {
  /** When the current step started (sim time; set on its first update). */
  private since = -1;
  /** Seconds into the briefing (cards and gaps). */
  private briefT = 0;
  private lastNow = -1;
  /** The opening's hostage, from the host's `captive` events. */
  private hostage: { phase: 'held' | 'freed' | 'executed'; executeAt: number } | null = null;

  constructor(public step: ObjectiveStep) {}

  /** Step to save. */
  get saved(): ObjectiveStep {
    return this.step;
  }

  private go(step: ObjectiveStep, now = -1): void {
    this.step = step;
    this.since = now;
  }

  onEvent(e: SimEvent, meId: number): void {
    // The area after the opening is cleared (driven there or not): the tour is over.
    if (e.type === 'chunkCleared' && (this.step === 'car' || this.step === 'hunt')) this.go('wrapup');
    if (e.type === 'buy' && e.ok && e.actorId === meId && this.step === 'upgrade') this.go('briefing');
    if (e.type === 'captive') this.hostage = { phase: e.phase, executeAt: e.executeAt };
  }

  /** The objective to show, or null once the tour is over. */
  update(c: ObjectiveContext): ObjectiveView | null {
    const p = c.player;
    if (this.since < 0) this.since = c.now;
    const dt = this.lastNow < 0 ? 0 : Math.max(0, c.now - this.lastNow);
    this.lastNow = c.now;
    // Steps can fall through several at once (e.g. already carrying a primary).
    if (this.step === 'ambush' && c.openingCleared) this.go('loot', c.now);
    // Picking a gun up doesn't draw it: the step ends once it's in hand (or they drive off).
    if (this.step === 'loot' && (p.inv.primary ? p.inv.active === 'primary' || p.vehicle >= 0 : !c.mp9)) this.go('car', c.now);
    if (this.step === 'car' && (p.vehicle >= 0 || !c.car)) this.go('hunt', c.now);
    if (this.step === 'wrapup') {
      if (c.inBuyZone && recommendUpgrade(p)) this.go('upgrade', c.now);
      else if (c.inBuyZone || c.now - this.since > WRAPUP_TIME) this.go('briefing', c.now);
    }
    const rec = this.step === 'upgrade' ? recommendUpgrade(p) : null;
    if (this.step === 'upgrade' && (!rec || !c.inBuyZone || c.now - this.since > UPGRADE_TIME)) this.go('briefing', c.now);
    // The briefing waits out any fight, and only counts down while it's up.
    if (this.step === 'briefing' && !c.inCombat) {
      // Only time since it came up, and no big jumps (a long pause between frames).
      this.briefT += Math.min(dt, c.now - this.since, 0.5);
      if (this.briefT >= BRIEFING.length * (CARD_TIME + CARD_GAP)) this.go('done', c.now);
    }

    switch (this.step) {
      case 'ambush': {
        const h = this.hostage;
        const target = centroid(c.openingBots) ?? c.openingCenter;
        if (h?.phase === 'held' && c.captive) {
          const left = h.executeAt >= 0 ? Math.max(0, Math.ceil(h.executeAt - c.now)) : null;
          const clock = left === null ? '' : ` · 0:${String(left).padStart(2, '0')}`;
          const urgent = left !== null && left <= WARN_TIME;
          const sub = urgent ? `He's about to shoot${clock} · take out the gunman` : `Take them out${clock} · Shift walks quietly`;
          return { ...view("They're about to execute a captured officer", sub, c.captive), urgent };
        }
        if (h?.phase === 'executed') return view('They killed the officer', 'Take them out · Shift walks quietly', target);
        return view("Two gang members ahead haven't seen you", 'Take them out · Shift walks quietly', target);
      }
      case 'loot':
        return p.inv.primary ? view(`Switch to the ${p.inv.primary.def.name}`, 'Press 1', null) : view('Grab an MP9', 'Walk over it to pick it up', c.mp9);
      case 'car':
        return view('Take a car', 'Shiny, intact cars still run · E to get in', c.car);
      case 'hunt':
        return c.nextArea
          ? view('Drive to the next area and clear it', `Danger ${c.nextArea.level} · +$${500 + 200 * c.nextArea.level}`, c.nextArea.pos)
          : view('Push further from spawn', 'Danger and pay rise the further out you go', null);
      case 'upgrade':
        return { ...view(`Upgrade: you can afford ${itemName(rec!)} ($${priceOf(p, rec!)})`, 'Press B to buy', null), highlight: rec };
      case 'briefing':
      {
        const i = Math.floor(this.briefT / (CARD_TIME + CARD_GAP));
        const inGap = this.briefT - i * (CARD_TIME + CARD_GAP) > CARD_TIME;
        if (c.inCombat || inGap || i >= BRIEFING.length) return null;
        return { ...view(BRIEFING[i].title, BRIEFING[i].sub, null), kicker: `How the city works · ${i + 1}/${BRIEFING.length}` };
      }
      case 'wrapup':
      case 'done':
        return null;
    }
  }
}

function view(title: string, sub: string, target: Vec3 | null): ObjectiveView {
  return { title, sub, target, highlight: null };
}

function centroid(pts: readonly Vec3[]): Vec3 | null {
  if (!pts.length) return null;
  const c = { x: 0, y: 0, z: 0 };
  for (const p of pts) {
    c.x += p.x / pts.length;
    c.y += p.y / pts.length;
    c.z += p.z / pts.length;
  }
  return c;
}

// ------------------------------------------------------------------ one-time tips

export type TipId = 'door' | 'locked' | 'ladder';

export const TIPS: Record<TipId, string> = {
  door: 'Doors: E opens · run at one and press E to kick it in (loud)',
  locked: 'Locked doors give way to two kicks, gunfire or an HE grenade',
  ladder: 'Ladders: walk into one to climb · look down to go down · jump to let go',
};

/** What the tips look at this frame. */
export interface TipContext {
  /** Door under the crosshair within reach, or null. */
  door: { locked: boolean } | null;
  nearLadder: boolean;
}

/** Tips shown once each (the seen set is kept by the caller, e.g. in localStorage). */
export class Tips {
  constructor(
    private seen: Set<TipId>,
    private onSeen: (seen: Set<TipId>) => void,
  ) {}

  /** A tip to show now, or null. */
  check(c: TipContext): string | null {
    if (c.door?.locked) return this.show('locked');
    if (c.door) return this.show('door');
    if (c.nearLadder) return this.show('ladder');
    return null;
  }

  private show(id: TipId): string | null {
    if (this.seen.has(id)) return null;
    this.seen.add(id);
    this.onSeen(this.seen);
    return TIPS[id];
  }
}

/** Both ends of every ladder in a chunk: x, y, z triples in world meters. */
export function ladderEnds(d: ChunkData): Float32Array {
  const links = d.navLinks;
  if (!links.length) return new Float32Array(0);
  const spanCol = spanColumns(d.navCol);
  const out: number[] = [];
  // Links come in pairs (up and down): each one's "from" span is one end.
  for (let k = 0; k < links.length; k += NAV_LINK_STRIDE) {
    const s = links[k];
    const c = spanCol[s];
    const i = c % NAV_RES;
    const j = (c - i) / NAV_RES;
    out.push(d.cx * CHUNK + (i + 0.5) * NAV_CELL, d.navFloor[s] / 100, d.cz * CHUNK + (j + 0.5) * NAV_CELL);
  }
  return new Float32Array(out);
}
