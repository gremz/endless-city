import * as THREE from 'three';
import { HitGroup } from '../ai/hitboxes';
import { DEG, vec3 } from '../core/math';
import type { Settings } from '../core/settings';
import type { Input } from '../input/Input';
import type { CameraController } from '../player/CameraController';
import { BotRenderer, type ActorRenderer } from '../render/BotRenderer';
import { loadCharacterAsset } from '../render/characters/CharacterAssets';
import { CharacterRenderer } from '../render/characters/CharacterRenderer';
import type { BotGroup } from '../render/characters/characterSpec';
import type { CharacterVariant } from '../render/characters/variants';
import { CompositeActorRenderer } from '../render/CompositeActorRenderer';
import { Team } from '../sim/Actor';
import { ChargeRenderer } from '../render/ChargeRenderer';
import { GrenadeRenderer } from '../render/GrenadeRenderer';
import { PickupRenderer } from '../render/PickupRenderer';
import { Decals, MuzzleLight, Particles, Tracers } from '../render/fx/Effects';
import type { Renderer } from '../render/Renderer';
import { Viewmodel } from '../render/viewmodel/Viewmodel';
import type { Simulation } from '../sim/Simulation';
import { flashAmount } from '../sim/Grenades';
import { plantProgress } from '../sim/breach';
import { healProgress } from '../sim/medkit';
import type { Pickup } from '../sim/Pickups';
import type { Hud } from '../ui/Hud';
import { activeItem } from '../weapons/Inventory';
import { getPattern, patternAt } from '../weapons/sprayPatterns';
import { currentInaccuracy } from '../weapons/WeaponSystem';
import { GRENADE_IDS, WEAPONS, type WeaponId } from '../weapons/weaponDefs';
import type { SimEvent } from '../core/events';
import { carSpeed } from '../sim/vehicle/carPhysics';

/** Kill feed names for deaths not caused by a weapon. */
const NON_WEAPON_NAMES: Record<string, string> = { car: 'Car', fall: 'Fall' };
import { Material, PieceKind } from '../world/gen/ChunkData';
import { SMOKE_HEALTH, VEHICLE_HEALTH } from '../sim/vehicle/Vehicle';

const NADE_LABELS: Record<string, string> = { hegrenade: 'HE', flashbang: 'FL', smokegrenade: 'SM', molotov: 'MO' };

export interface EventSink {
  handle(e: SimEvent, sim: Simulation): void;
}

/**
 * Read-only view of the simulation: consumes sim events each frame and drives effects,
 * the viewmodel, bot models and HUD. Never writes into the simulation.
 */
export class Presentation {
  /** Box figures, or the animated characters once their models have loaded (and the setting allows). */
  bots: ActorRenderer;
  /** Loaded character models: bots, and players (other players, co-op allies). */
  private assets: { bot: CharacterVariant[] | null; player: CharacterVariant[] | null } = { bot: null, player: null };
  /** Which models `bots` currently draws with (null: box figures). */
  private drawn = { bot: null as CharacterVariant[] | null, player: null as CharacterVariant[] | null };
  private disposed = false;
  readonly pickupRenderer: PickupRenderer;
  /** Items lying in the world (set by the game when pickups exist). */
  pickups: readonly Pickup[] = [];
  /** Bots with a lit flashlight (set by the game at night). */
  torches: ReadonlySet<number> = new Set();
  /** Actor id of the player this screen belongs to. */
  localId = -1;
  /** A cinematic camera (title, intro) has the view: no gun in it. */
  cinematic = false;
  private torchLevel = 0;
  readonly viewmodel: Viewmodel;
  readonly tracers = new Tracers();
  readonly decals = new Decals();
  readonly particles = new Particles();
  readonly muzzleLight = new MuzzleLight();
  readonly grenades: GrenadeRenderer;
  private charges = new ChargeRenderer();
  /** Extra event consumers (audio, kill rewards UI...). */
  readonly sinks: EventSink[] = [];
  private tmp = new THREE.Vector3();
  private recoil = { pitch: 0, yaw: 0 };
  private baseFov = 74;

  constructor(
    private renderer: Renderer,
    private hud: Hud,
    private camCtl: CameraController,
    private input: Input,
    private settings: Settings,
    /** Character models to load for bots (one per variant) and players; null draws box figures for them. */
    characterUrls: { bots: { url: string; group?: BotGroup }[] | null; player: string | null },
  ) {
    this.bots = new BotRenderer(settings.shadows > 0);
    if (characterUrls.bots) void this.loadCharacters('bot', characterUrls.bots);
    if (characterUrls.player) void this.loadCharacters('player', [{ url: characterUrls.player }]);
    this.pickupRenderer = new PickupRenderer(settings.shadows > 0);
    this.grenades = new GrenadeRenderer(this.particles);
    const scene = renderer.scene;
    scene.add(this.bots.root, this.pickupRenderer.root, this.grenades.root, this.charges.root, this.tracers.mesh, this.decals.mesh, this.particles.points, this.muzzleLight.light);
    this.viewmodel = new Viewmodel(renderer.camera.aspect);
    this.viewmodel.setFovFromHorizontal43(settings.viewmodelFov);
    renderer.overlays.push({ scene: this.viewmodel.scene, camera: this.viewmodel.camera });
    this.baseFov = renderer.camera.fov;
  }

  applySettings(): void {
    this.viewmodel.setFovFromHorizontal43(this.settings.viewmodelFov);
    this.baseFov = this.renderer.camera.fov;
    this.bots.setShadows(this.settings.shadows > 0);
    this.useCharacters();
    this.pickupRenderer.setShadows(this.settings.shadows > 0);
    this.hud.applyCrosshairStyle();
  }

  /** Load every model of a kind; the ones that fail are left out (all failing: box figures). */
  private async loadCharacters(kind: 'bot' | 'player', models: { url: string; group?: BotGroup }[]): Promise<void> {
    const results = await Promise.allSettled(models.map((m) => loadCharacterAsset(m.url)));
    const variants: CharacterVariant[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') variants.push({ asset: r.value, group: models[i].group });
      else console.info(`Character model ${models[i].url} not used (${(r.reason as Error).message}).`);
    });
    if (this.disposed) {
      for (const v of variants) v.asset.dispose();
      return;
    }
    if (!variants.length) {
      console.info(`No ${kind} character models loaded; drawing box figures.`);
      return;
    }
    this.assets[kind] = variants;
    this.useCharacters();
  }

  /**
   * Switch between the box figures and the loaded characters to match the setting. Players use
   * the player model (or the bots' if it's missing); anyone without a model is a box figure.
   */
  private useCharacters(): void {
    const detailed = this.settings.characters === 'detailed';
    const bot = detailed ? this.assets.bot : null;
    const player = detailed ? (this.assets.player ?? this.assets.bot) : null;
    if (bot === this.drawn.bot && player === this.drawn.player) return;
    this.drawn = { bot, player };
    const scene = this.renderer.scene;
    scene.remove(this.bots.root);
    this.bots.dispose();
    const shadows = this.settings.shadows > 0;
    const make = (variants: CharacterVariant[] | null): ActorRenderer => (variants ? new CharacterRenderer(variants, this.renderer.camera, shadows) : new BotRenderer(shadows));
    this.bots =
      bot === player
        ? make(bot)
        : new CompositeActorRenderer([
            { renderer: make(player), accept: (a) => a.team === Team.Player },
            { renderer: make(bot), accept: () => true },
          ]);
    scene.add(this.bots.root);
  }

  /** Recompute base FOV after the renderer's FOV changed. */
  setBaseFov(fov: number): void {
    this.baseFov = fov;
  }

  handleEvents(sim: Simulation): void {
    const player = sim.getActor(this.localId) ?? sim.player;
    for (const e of sim.events.drain()) {
      switch (e.type) {
        case 'shot': {
          const mine = e.shooterId === player.id;
          if (mine) {
            this.viewmodel.onShot(e.weapon);
            if (e.weapon !== 'knife') {
              const muzzle = this.viewmodel.muzzleWorld(this.renderer.camera, this.tmp);
              this.muzzleLight.flash(muzzle.x, muzzle.y, muzzle.z);
              if (e.tracer) this.tracers.spawn(vec3(muzzle.x, muzzle.y, muzzle.z), e.to);
            }
          } else if (e.weapon !== 'knife') {
            // Bot muzzle: roughly at the gun in front of the chest.
            const dx = e.to.x - e.from.x;
            const dz = e.to.z - e.from.z;
            const l = Math.hypot(dx, dz) || 1;
            const from = vec3(e.from.x + (dx / l) * 0.7, e.from.y - 0.25, e.from.z + (dz / l) * 0.7);
            this.muzzleLight.flash(from.x, from.y, from.z, 0.7);
            if (e.tracer) this.tracers.spawn(from, e.to);
          }
          break;
        }
        case 'impact':
          // No bullet holes on cars (they'd stay behind when the car drives off) or on window
          // panes (any hit shatters them, which would leave the hole floating in the empty frame).
          if (e.chunkKey >= 0 && e.material !== Material.Glass) this.decals.add(e.pos, e.normal, e.chunkKey);
          this.particles.impact(e.pos, e.normal, e.material);
          break;
        case 'hit': {
          const attacker = sim.getActor(e.attackerId);
          const dir = attacker
            ? { x: e.pos.x - attacker.move.pos.x, y: 0, z: e.pos.z - attacker.move.pos.z }
            : { x: 0, y: 0, z: 1 };
          const l = Math.hypot(dir.x, dir.z) || 1;
          this.particles.blood(e.pos, dir.x / l, 0.3, dir.z / l, e.group === HitGroup.Head);
          if (e.attackerId === player.id && e.victimId !== player.id) {
            this.hud.hit(e.killed ? 'kill' : e.group === HitGroup.Head ? 'head' : 'body');
          }
          if (e.victimId === player.id && attacker && attacker !== player) {
            // Screen-space angle to the attacker for the damage arc (0 = straight ahead).
            const ang = Math.atan2(attacker.move.pos.x - player.move.pos.x, attacker.move.pos.z - player.move.pos.z);
            const viewAng = Math.atan2(-Math.sin(this.input.yaw), -Math.cos(this.input.yaw));
            this.hud.damaged(viewAng - ang);
          }
          break;
        }
        case 'kill': {
          const killer = sim.getActor(e.attackerId);
          const victim = sim.getActor(e.victimId);
          const weaponName = WEAPONS[e.weapon as WeaponId]?.name ?? NON_WEAPON_NAMES[e.weapon] ?? e.weapon;
          this.hud.killFeed(
            killer?.name ?? '?',
            victim?.name ?? '?',
            weaponName,
            e.headshot,
            e.attackerId === player.id || e.victimId === player.id,
            e.penetrated,
          );
          break;
        }
        case 'land':
          if (e.actorId === player.id) this.viewmodel.onLand(e.speed);
          break;
        case 'step':
          if (e.material === Material.Water) this.particles.splash(e.pos);
          break;
        case 'piece_break':
          if (e.kind === PieceKind.Glass) this.particles.shards(e.pos);
          else if (e.kind === PieceKind.Breach) this.particles.rubble(e.pos);
          break;
        case 'door':
          if (e.action === 'break') this.particles.splinters(e.pos);
          break;
        case 'breach_detonate':
          this.particles.explosion(e.pos);
          this.muzzleLight.flash(e.pos.x, e.pos.y, e.pos.z, 5, 0.14, 24);
          break;
        case 'nade_throw':
          if (e.actorId === player.id) this.viewmodel.onThrow();
          break;
        case 'nade_detonate': {
          const pos = e.pos;
          if (e.kind === 'hegrenade') {
            this.particles.explosion(pos);
            this.muzzleLight.flash(pos.x, pos.y + 0.5, pos.z, 5, 0.14, 24);
            if (e.normal) this.decals.add(pos, e.normal, e.chunkKey, 2.4);
          } else if (e.kind === 'flashbang') {
            this.particles.flashPop(pos);
            this.muzzleLight.flash(pos.x, pos.y, pos.z, 8, 0.07, 30);
          } else if (e.kind === 'molotov') {
            this.particles.glass(pos);
            this.muzzleLight.flash(pos.x, pos.y + 0.4, pos.z, 3, 0.2, 12);
            if (e.normal) this.decals.add(pos, e.normal, e.chunkKey, 2.2);
          }
          break;
        }
        case 'message':
          if (e.actorId < 0 || e.actorId === player.id) this.hud.message(e.text);
          break;
        case 'pickup':
          if (e.actorId !== player.id) break;
          if (e.item === 'medkit') this.hud.message(`+1 Medkit  (${player.medkits})`, 1.4, 'heal');
          else if (e.item === 'ammo') this.hud.message(`+${e.amount} rounds`, 1.4);
          else this.hud.message(`Picked up ${WEAPONS[e.item as WeaponId]?.name ?? e.item}`, 1.6);
          break;
        case 'heal':
          if (e.actorId === player.id && e.phase === 'done') {
            this.hud.healed();
            this.hud.message(`+${e.amount} HP`, 1.2, 'heal');
          }
          break;
      }
      this.bots.onEvent?.(e);
      for (const s of this.sinks) s.handle(e, sim);
    }
  }

  update(sim: Simulation, alpha: number, frameDt: number): void {
    const p = sim.getActor(this.localId) ?? sim.player;
    const simTime = sim.time + alpha * sim.dt;
    this.bots.update(sim.actors, p.id, alpha, sim.time, frameDt, this.torches, this.torchLevel);
    this.pickupRenderer.update(this.pickups, simTime, frameDt);
    this.tracers.update(frameDt);
    this.particles.update(frameDt);
    this.muzzleLight.update(frameDt);
    this.grenades.update(sim.grenades, alpha, simTime, frameDt, this.renderer.camera.position);
    this.charges.update(sim.charges, simTime);

    // Recoil view punch: the camera follows part of the spray pattern.
    const item = activeItem(p.inv);
    const def = item.def;
    patternAt(getPattern(def.pattern), p.wpn.recoilIndex, this.recoil);
    this.camCtl.punchPitch = this.recoil.pitch * def.viewFollow * DEG;
    this.camCtl.punchYaw = this.recoil.yaw * def.viewFollow * DEG;

    // Scope: zoom FOV, hide viewmodel, scale sensitivity.
    const cam = this.renderer.camera;
    const scoped = p.wpn.scope > 0 && !!def.zoomFovs && p.alive;
    let fov = this.baseFov;
    if (scoped) {
      const h = def.zoomFovs![p.wpn.scope - 1] * DEG;
      fov = (2 * Math.atan(Math.tan(h / 2) / (4 / 3))) / DEG;
    }
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    this.input.sensScale = scoped ? (fov / this.baseFov) * this.settings.zoomSensitivityRatio : 1;
    const car = sim.vehicleOf(p);
    this.viewmodel.visible = !scoped && !car && !this.cinematic;
    this.hud.setScope(scoped);
    this.viewmodel.update(frameDt, p, simTime, this.input.yaw, this.input.pitch);

    // HUD.
    this.hud.setVitals(p.health, p.armor, p.helmet);
    this.hud.setMedkits(p.medkits, healProgress(p, simTime), p.alive && p.medkits > 0 && p.health <= 50 && p.healEnd < 0);
    this.hud.setCharges(p.breachCharges, plantProgress(p, simTime));
    this.hud.setAmmo(def.name, item.clip, item.reserve, def.category === 'knife' ? 'melee' : def.category === 'grenade' ? 'count' : 'gun');
    this.hud.setGrenades(
      GRENADE_IDS.filter((id) => p.inv.nades[id] > 0).map((id) => ({ kind: id, label: NADE_LABELS[id], count: p.inv.nades[id] })),
      p.inv.nadeSel,
      p.inv.active === 'grenade',
    );
    this.hud.setFlash(p.alive ? flashAmount(p, simTime) : 0);
    this.hud.setClock(sim.env.hour, sim.env.daylight, sim.env.weather);
    const inacc = currentInaccuracy(p) * 0.001;
    this.hud.setSpread(inacc, cam.fov * DEG, window.innerHeight, !scoped && p.alive && !car);
    this.hud.setDriving(car ? { speed: carSpeed(car.car), health: car.health / VEHICLE_HEALTH, smoking: car.health < SMOKE_HEALTH } : null);
    this.hud.update(frameDt);
  }

  /** World light level for things lit outside the scene (viewmodel) and tinted smoke. */
  setWorldLight(viewmodel: number, daylight: number): void {
    this.torchLevel = Math.max(0, Math.min(1, (0.75 - daylight) / 0.5));
    this.viewmodel.setLightScale(viewmodel);
    this.grenades.smokeColor.setScalar(0.8 * (0.22 + 0.78 * daylight));
  }

  onChunkUnloaded(key: number): void {
    this.decals.removeChunk(key);
  }

  dispose(): void {
    this.disposed = true;
    this.bots.dispose();
    for (const v of [...(this.assets.bot ?? []), ...(this.assets.player ?? [])]) v.asset.dispose();
    this.pickupRenderer.dispose();
    this.grenades.dispose();
    this.charges.dispose();
    this.viewmodel.dispose();
  }
}
