import { HitGroup } from '../ai/hitboxes';
import type { SimEvent } from '../core/events';
import { vec3, type Vec3 } from '../core/math';
import type { Simulation } from '../sim/Simulation';
import { Material } from '../world/gen/ChunkData';
import { WEAPONS, type WeaponId } from '../weapons/weaponDefs';
import type { AudioEngine } from './AudioEngine';

/** Maps simulation events to sounds (own gun in-head, everyone else positional). */
export class SoundEvents {
  readonly listener = vec3();
  private lastImpact = 0;
  private clock = 0;

  constructor(private audio: AudioEngine) {}

  tick(dt: number): void {
    this.clock += dt;
  }

  handle(e: SimEvent, sim: Simulation): void {
    const a = this.audio;
    const me = sim.player.id;
    const L = this.listener;
    switch (e.type) {
      case 'shot': {
        const def = WEAPONS[e.weapon as WeaponId];
        if (!def) return;
        if (e.shooterId === me) a.play(def.sound, { volume: 0.55, reverb: 0.3 });
        else a.play(def.sound, { pos: e.from, volume: 1.4, reverb: 0.45 }, L);
        break;
      }
      case 'step':
        if (e.actorId === me) a.play('step', { volume: 0.18, reverb: 0.05 });
        else a.play('step', { pos: e.pos, volume: 0.9, reverb: 0.1 }, L);
        break;
      case 'land':
        if (e.actorId === me && e.speed > 3) a.play('land', { volume: Math.min(0.6, e.speed * 0.06) });
        break;
      case 'reload':
        if (e.actorId === me) a.play('reload', { volume: 0.5, reverb: 0.05 });
        else this.at(sim, e.actorId, (p) => a.play('reload', { pos: p, volume: 0.6 }, L));
        break;
      case 'deploy':
        if (e.actorId === me) a.play('deploy', { volume: 0.4, reverb: 0.05 });
        break;
      case 'dryfire':
        if (e.actorId === me) a.play('dryfire', { volume: 0.5, reverb: 0 });
        break;
      case 'impact': {
        if (this.clock - this.lastImpact < 0.03) return;
        if (Math.hypot(e.pos.x - L.x, e.pos.y - L.y, e.pos.z - L.z) > 30) return;
        this.lastImpact = this.clock;
        const metal = e.material === Material.Metal;
        a.play(metal && Math.random() < 0.3 ? 'ricochet' : 'impact', { pos: e.pos, volume: metal ? 0.5 : 0.35, reverb: 0.1 }, L);
        break;
      }
      case 'hit':
        if (e.attackerId === me) {
          if (e.group === HitGroup.Head && e.helmetHit) a.play('headshot', { volume: 0.5, reverb: 0 });
          else a.play('hit', { volume: e.group === HitGroup.Head ? 0.7 : 0.45, reverb: 0 });
        } else if (e.victimId === me) {
          a.play('hurt', { volume: 0.6, reverb: 0 });
        }
        break;
      case 'kill':
        if (e.attackerId === me) a.play('kill', { volume: 0.35, reverb: 0 });
        break;
      case 'buy':
        a.play(e.ok ? 'buy' : 'deny', { volume: 0.5, reverb: 0 });
        break;
      case 'chunkCleared':
        a.play('cleared', { volume: 0.5, reverb: 0.2 });
        break;
    }
  }

  private at(sim: Simulation, id: number, fn: (p: Vec3) => void): void {
    const actor = sim.getActor(id);
    if (actor) fn(actor.move.pos);
  }
}
