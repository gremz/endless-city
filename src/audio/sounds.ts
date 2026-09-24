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
  private lastBounce = 0;
  private fireAt = 0;
  private clock = 0;
  /** Actor id of the player listening (their own sounds play un-positioned). */
  localId = -1;

  constructor(private audio: AudioEngine) {}

  tick(dt: number): void {
    this.clock += dt;
  }

  /** Thunder `delay` seconds after a lightning flash. */
  thunder(delay: number, strength: number): void {
    setTimeout(() => this.audio.play('thunder', { volume: 0.9 * strength, reverb: 0.5 }), delay * 1000);
  }

  /** Crackle loops for burning molotovs (retriggered, since one-shots can't loop). */
  fires(sim: Simulation): void {
    if (this.clock < this.fireAt) return;
    this.fireAt = this.clock + 0.9;
    const L = this.listener;
    for (const f of sim.grenades.fires) {
      if (Math.hypot(f.pos.x - L.x, f.pos.z - L.z) > 40) continue;
      this.audio.play('fire', { pos: f.pos, volume: 0.9, reverb: 0.15 }, L);
    }
  }

  handle(e: SimEvent, sim: Simulation): void {
    const a = this.audio;
    const me = this.localId;
    const L = this.listener;
    switch (e.type) {
      case 'shot': {
        const def = WEAPONS[e.weapon as WeaponId];
        if (!def) return;
        if (e.shooterId === me) a.play(def.sound, { volume: 0.55, reverb: 0.3 });
        else a.play(def.sound, { pos: e.from, volume: 1.4, reverb: 0.45 }, L);
        break;
      }
      case 'step': {
        const name = sim.env.rain > 0.3 ? 'step_wet' : 'step';
        // Metal (ladder rungs, fire escape grates) rings higher.
        const rate = e.material === Material.Metal ? 1.9 : 1;
        if (e.actorId === me) a.play(name, { volume: 0.18, reverb: 0.05, rate });
        else a.play(name, { pos: e.pos, volume: 0.9, reverb: 0.1, rate }, L);
        break;
      }
      case 'flashlight':
        if (e.actorId === me) a.play('flashlight', { volume: 0.4, reverb: 0 });
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
        const metal = e.material === Material.Metal || e.material === Material.CarPaint;
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
      case 'pickup':
        if (e.actorId === me) a.play('pickup', { volume: 0.55, reverb: 0 });
        break;
      case 'heal':
        if (e.actorId !== me) break;
        if (e.phase === 'start') a.play('heal', { volume: 0.3, rate: 0.9, reverb: 0.05 });
        else if (e.phase === 'done') a.play('heal', { volume: 0.55, reverb: 0.1 });
        break;
      case 'nade_pin':
        if (e.actorId === me) a.play('pin_pull', { volume: 0.5, reverb: 0.02 });
        break;
      case 'nade_throw':
        if (e.actorId === me) a.play('nade_throw', { volume: 0.45, reverb: 0.02 });
        else this.at(sim, e.actorId, (p) => a.play('nade_throw', { pos: p, volume: 0.7 }, L));
        break;
      case 'nade_bounce':
        if (this.clock - this.lastBounce < 0.05) return;
        this.lastBounce = this.clock;
        a.play('nade_bounce', { pos: e.pos, volume: Math.min(0.9, 0.2 + e.speed * 0.06), reverb: 0.1 }, L);
        break;
      case 'nade_detonate': {
        const name = e.kind === 'hegrenade' ? 'he_explode' : e.kind === 'flashbang' ? 'flash_bang' : e.kind === 'smokegrenade' ? 'smoke_pop' : 'molotov_break';
        const vol = e.kind === 'hegrenade' ? 2.2 : e.kind === 'flashbang' ? 1.8 : 1;
        a.play(name, { pos: e.pos, volume: vol, reverb: e.kind === 'hegrenade' ? 0.6 : 0.35 }, L);
        break;
      }
      case 'flashed':
        // The ringing plays outside the muffled effects bus.
        if (e.actorId === me && e.strength > 0.25) a.play('flash_ring', { volume: Math.min(0.7, e.strength * 0.8), reverb: 0, bus: 'master' });
        break;
      case 'fire_out':
        a.play('fire_out', { pos: e.pos, volume: 0.8, reverb: 0.2 }, L);
        break;
      case 'car_door':
        a.play('car_door', { pos: e.pos, volume: e.actorId === me ? 0.7 : 0.9, reverb: 0.1 }, L);
        break;
      case 'car_crash':
        if (Math.hypot(e.pos.x - L.x, e.pos.z - L.z) > 60) return;
        a.play('car_crash', { pos: e.pos, volume: Math.min(1.6, 0.25 + e.speed * 0.06), reverb: 0.3 }, L);
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
