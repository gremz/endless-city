import * as THREE from 'three';
import { CHUNK, HU } from '../core/config';
import { FixedLoop } from '../core/loop';
import { loadSettings, saveSettings, type Settings } from '../core/settings';
import type { GameParams } from '../core/urlParams';
import { DEBUG_KEYS } from '../input/bindings';
import { Input } from '../input/Input';
import { makeCmd } from '../input/UserCmd';
import { CameraController } from '../player/CameraController';
import { ChunkRenderer } from '../render/ChunkRenderer';
import { MaterialLibrary } from '../render/materials';
import { Renderer } from '../render/Renderer';
import { teleport } from '../sim/Actor';
import { makeInventory } from '../weapons/Inventory';
import { Simulation } from '../sim/Simulation';
import { DebugOverlay } from '../ui/DebugOverlay';
import { Hud } from '../ui/Hud';
import { MainMenu } from '../ui/Menus';
import { worldToChunk } from '../world/chunkMath';
import { DISTRICT_NAMES } from '../world/gen/ChunkData';
import { generateChunk } from '../world/gen/generateChunk';
import { generateGymChunk } from '../world/gen/gymGen';
import { WorkerChunkSource } from '../world/WorkerChunkSource';
import { SyncChunkSource, WorldStreamer, type ChunkSource } from '../world/WorldStreamer';
import { Presentation } from './Presentation';
import { EncounterManager } from '../ai/EncounterManager';
import { AudioEngine } from '../audio/AudioEngine';
import { SoundEvents } from '../audio/sounds';
import { buy, buyZoneStatus, owned, priceOf, type BuyItem } from '../sim/buy';
import { BuyMenu } from '../ui/BuyMenu';
import { SettingsMenu } from '../ui/SettingsMenu';
import { SLOT_KEYS } from '../input/bindings';
import { stuckSnaps } from '../ai/Bot';
import { Buttons } from '../input/UserCmd';
import { chunkKey, keyToCoords } from '../world/chunkMath';
import { WEAPONS, type WeaponId } from '../weapons/weaponDefs';
import { eyeHeight } from '../player/pmove';

type State = 'menu' | 'playing' | 'paused';

interface KeyboardLock {
  lock(keys?: string[]): Promise<void>;
  unlock(): void;
}

/** Composition root: wires simulation, streaming, rendering, input and UI, and owns the frame loop. */
export class Game {
  readonly sim: Simulation;
  readonly streamer: WorldStreamer;
  readonly renderer: Renderer;
  readonly input: Input;
  readonly settings: Settings;
  private materials: MaterialLibrary;
  private chunkRenderer: ChunkRenderer;
  private camCtl = new CameraController();
  private debug: DebugOverlay;
  private menu: MainMenu;
  private hud: Hud;
  private presentation: Presentation;
  readonly encounters: EncounterManager | null;
  private death: { killer: number; text: string } | null = null;
  private buyMenu: BuyMenu;
  readonly audio = new AudioEngine();
  private sounds = new SoundEvents(this.audio);
  private fwd = new THREE.Vector3();
  private up = new THREE.Vector3();
  private settingsMenu: SettingsMenu;
  private saveTimer = 0;
  private loop: FixedLoop;
  private cmd = makeCmd();
  private state: State = 'menu';
  /** Waiting for the chunks around spawn before the player can drop in. */
  private loading = true;
  private spawnX = 0;
  private spawnZ = 0;
  private raf = 0;
  private lastFrame = 0;
  private disposers: (() => void)[] = [];
  private focus = new THREE.Vector3();
  timeScale = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    private ui: HTMLElement,
    readonly params: GameParams,
  ) {
    this.settings = loadSettings();
    const tickDt = 1 / params.tickRate;
    this.loop = new FixedLoop(tickDt);
    this.sim = new Simulation(params, { autoBhop: this.settings.autoBhop }, tickDt);

    this.renderer = new Renderer(canvas);
    this.materials = new MaterialLibrary(this.renderer.anisotropy);
    this.chunkRenderer = new ChunkRenderer(this.materials, this.settings.shadows > 0);
    this.renderer.scene.add(this.chunkRenderer.root);

    const source: ChunkSource =
      params.world === 'city'
        ? new WorkerChunkSource(params.seed, 'city', generateChunk)
        : new SyncChunkSource(params.seed, generateGymChunk);
    this.streamer = new WorldStreamer(this.sim.world, source);
    this.streamer.addListener(this.chunkRenderer);
    this.streamer.addListener(this.sim.nav);
    this.encounters = params.world === 'city' ? new EncounterManager(this.sim, this.streamer) : null;
    if (this.encounters) this.sim.systems.push(this.encounters);

    this.input = new Input(canvas);
    this.hud = new Hud(ui, this.settings);
    this.hud.setVisible(false);
    this.presentation = new Presentation(this.renderer, this.hud, this.camCtl, this.input, this.settings);
    this.streamer.addListener({
      onChunkLoaded: () => {},
      onChunkVisibility: () => {},
      onChunkUnloaded: (key) => this.presentation.onChunkUnloaded(key),
    });
    this.presentation.sinks.push(this.sounds);
    this.presentation.sinks.push({
      handle: (e) => {
        if (e.type === 'money') this.hud.flashMoney(e.amount);
        else if (e.type === 'chunkCleared') this.hud.message(`AREA CLEARED  +$${e.bonus}  ·  buy zone unlocked`, 3.5);
        else if (e.type === 'buy') {
          const name = e.item === 'kevlar' ? 'Kevlar Vest' : e.item === 'helmet' ? 'Kevlar + Helmet' : (WEAPONS[e.item as WeaponId]?.name ?? e.item);
          this.buyMenu.feedback(e.ok ? `Bought ${name}` : (e.reason ?? 'Cannot buy'), e.ok);
        }
        else if (e.type === 'kill' && e.victimId === this.sim.player.id) {
          const k = this.sim.getActor(e.attackerId);
          const w = WEAPONS[e.weapon as WeaponId]?.name ?? e.weapon;
          this.death = { killer: e.attackerId, text: `Killed by ${k?.name ?? 'someone'} (${w}${e.headshot ? ', headshot' : ''})` };
        }
      },
    });
    this.debug = new DebugOverlay(ui, params.debug || this.settings.showFps);
    this.menu = new MainMenu(ui, {
      onPlay: (fs) => void this.play(fs),
      onSettings: () => {
        this.menu.hide();
        this.settingsMenu.show();
      },
    });
    this.settingsMenu = new SettingsMenu(
      ui,
      this.settings,
      () => this.applySettings(),
      () => {
        this.settingsMenu.hide();
        this.menu.show(this.state === 'menu' ? 'title' : 'paused');
      },
    );
    const economy = this.sim.economy;
    this.buyMenu = new BuyMenu(
      ui,
      {
        get money() {
          return economy.money;
        },
        price: (item) => priceOf(this.sim, item),
        owned: (item) => owned(this.sim, item),
        zone: () => buyZoneStatus(this.sim, this.engagedNearby()),
      },
      (item: BuyItem) => buy(this.sim, item, this.engagedNearby()),
    );
    this.menu.setSeed(params.seedText);

    this.applySettings();
    this.spawnPlayer();
    this.bindEvents();
  }

  private applySettings(): void {
    const s = this.settings;
    this.input.sensitivity = s.sensitivity;
    this.input.invertY = s.invertY;
    this.renderer.setFovFromHorizontal43(s.fov);
    this.presentation?.setBaseFov(this.renderer.camera.fov);
    this.presentation?.applySettings();
    this.renderer.setShadowMapSize(s.shadows);
    this.renderer.setRenderScale(s.renderScale);
    this.chunkRenderer.setShadows(s.shadows > 0);
    this.sim.opts.autoBhop = s.autoBhop;
    this.audio.setVolume(s.masterVolume);
    if (this.debug) {
      const want = this.params.debug || s.showFps;
      if (want !== this.debug.visible) this.debug.toggle();
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => saveSettings(s), 300);
  }

  /** Choose the spawn point; the player is placed once the surrounding chunks exist. */
  private spawnPlayer(): void {
    if (this.params.world === 'range') {
      this.spawnX = CHUNK + 5;
      this.spawnZ = 30;
    } else if (this.params.world === 'gym') {
      this.spawnX = this.params.spawnCx * CHUNK + 32;
      this.spawnZ = this.params.spawnCz * CHUNK + 20;
    } else {
      // City: the spawn plaza, just south of the fountain.
      this.spawnX = this.params.spawnCx * CHUNK + 32;
      this.spawnZ = this.params.spawnCz * CHUNK + 22;
    }
    teleport(this.sim.player, this.spawnX, 30, this.spawnZ);
    this.menu.setReady(false);
    this.menu.setStatus('Generating the city…');
  }

  private finishSpawn(): void {
    this.loading = false;
    const p = this.sim.player;
    teleport(p, this.spawnX, this.sim.findFloor(this.spawnX, this.spawnZ, 20), this.spawnZ);
    this.input.pitch = 0;
    if (this.params.world === 'range') {
      this.input.yaw = -Math.PI / 2; // face +X down the lanes
      const ox = CHUNK;
      const d = (x: number, z: number, armor = 0, helmet = false) =>
        this.sim.spawnDummy(ox + x, 0.05, z, Math.PI / 2, armor, helmet);
      d(20, 18);
      d(35, 18, 100, false);
      d(55, 18, 100, true);
      d(15, 30);
      d(24, 32, 100, true); // behind the wooden panel
      d(40, 30);
      d(58, 42, 100, true);
      d(28, 42);
      d(40, 55); // through the doorway
      p.inv = makeInventory('glock', 'ak47');
    } else if (this.params.world === 'gym') {
      this.input.yaw = Math.PI; // face +Z (towards the test course)
      this.sim.spawnDummy(32, 0.05, 30, 0, 100, true);
    } else {
      this.input.yaw = Math.PI;
    }
    this.menu.setStatus('');
    this.menu.setReady(true);
  }

  private bindEvents(): void {
    const onResize = () => this.renderer.resize();
    window.addEventListener('resize', onResize);
    this.disposers.push(() => window.removeEventListener('resize', onResize));

    const onLockChange = () => {
      if (document.pointerLockElement === this.canvas) {
        this.state = 'playing';
        this.menu.hide();
        this.hud.setVisible(true);
        this.loop.reset();
      } else if (this.state === 'playing') {
        this.pause();
      }
    };
    const onLockError = () => this.menu.setStatus('Could not capture the mouse — click Resume again.');
    document.addEventListener('pointerlockchange', onLockChange);
    document.addEventListener('pointerlockerror', onLockError);
    this.disposers.push(() => {
      document.removeEventListener('pointerlockchange', onLockChange);
      document.removeEventListener('pointerlockerror', onLockError);
    });

    const onVisibility = () => {
      if (document.hidden && this.state === 'playing') this.input.exitLock();
    };
    document.addEventListener('visibilitychange', onVisibility);
    this.disposers.push(() => document.removeEventListener('visibilitychange', onVisibility));

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (this.state === 'playing') e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    this.disposers.push(() => window.removeEventListener('beforeunload', onBeforeUnload));

    this.disposers.push(
      this.input.onKeyDown((code) => {
        if (code === DEBUG_KEYS.overlay) this.debug.toggle();
        if (this.state === 'playing' && this.sim.player.alive) {
          if (code === 'KeyB') this.buyMenu.toggle();
          else if (this.buyMenu.open && code in SLOT_KEYS) this.buyMenu.select(SLOT_KEYS[code]);
        }
        if (!this.params.debug && this.params.world !== 'gym') return;
        if (code === DEBUG_KEYS.noclip) this.sim.player.move.noclip = !this.sim.player.move.noclip;
        if (code === DEBUG_KEYS.slowmo) this.timeScale = this.timeScale === 1 ? 0.25 : 1;
      }),
    );
  }

  private async play(fullscreen: boolean): Promise<void> {
    if (this.loading) return;
    this.menu.setStatus('');
    // Audio may only start from a user gesture.
    void this.audio.unlock();
    if (fullscreen && !document.fullscreenElement) {
      try {
        await document.documentElement.requestFullscreen();
        const kb = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
        if (kb) {
          await kb.lock();
          this.input.keyboardLocked = true;
        }
      } catch {
        this.menu.setStatus('Fullscreen was blocked; playing windowed.');
      }
    }
    try {
      await this.input.requestLock();
    } catch {
      this.menu.setStatus('Could not capture the mouse — click again in a second.');
    }
  }

  private pause(): void {
    this.state = 'paused';
    this.buyMenu.close();
    this.menu.show('paused');
    this.input.keyboardLocked = !!document.fullscreenElement && this.input.keyboardLocked;
  }

  start(): void {
    this.lastFrame = performance.now();
    const frame = (now: number) => {
      this.raf = requestAnimationFrame(frame);
      this.frame(now);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private frame(now: number): void {
    const frameMs = now - this.lastFrame;
    this.lastFrame = now;
    const dt = Math.min(frameMs / 1000, 0.25) * this.timeScale;
    const p = this.sim.player;

    let alpha = 1;
    if (this.state === 'playing') {
      // Never simulate on top of an unloaded chunk.
      const ready = this.streamer.isLoaded(p.move.pos.x, p.move.pos.z);
      if (ready) {
        alpha = this.loop.advance(dt, () => {
          this.input.buildCmd(this.cmd);
          this.sim.step(this.cmd);
          if (!p.alive) this.deadTick();
        });
      }
    }
    this.updateDeathView(dt);

    if (this.loading) {
      this.streamer.update(this.spawnX, this.spawnZ, this.input.yaw);
      this.streamer.apply(4, 2);
      if (this.streamer.allLoaded(this.spawnX, this.spawnZ, 1)) this.finishSpawn();
    } else {
      this.streamer.update(p.move.pos.x, p.move.pos.z, this.input.yaw);
      this.streamer.apply(1);
    }

    this.presentation.update(this.sim, alpha, frameMs / 1000);
    const cam = this.renderer.camera;
    this.camCtl.update(cam, p, alpha, this.input.yaw, this.input.pitch);
    // Audio listener follows the camera.
    cam.getWorldDirection(this.fwd);
    this.up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    this.sounds.listener.x = cam.position.x;
    this.sounds.listener.y = cam.position.y;
    this.sounds.listener.z = cam.position.z;
    this.audio.setListener(cam.position.x, cam.position.y, cam.position.z, this.fwd.x, this.fwd.y, this.fwd.z, this.up.x, this.up.y, this.up.z);
    this.sounds.tick(frameMs / 1000);
    this.presentation.handleEvents(this.sim);
    this.focus.set(this.camCtl.position.x, 0, this.camCtl.position.z);
    this.renderer.updateSun(this.focus);
    this.renderer.render();

    this.updateHudExtras();
    this.debug.frame(frameMs);
    this.debug.setSpeed(Math.hypot(p.move.vel.x, p.move.vel.z) / HU, p.move.onGround);
    if (this.debug.due(now)) this.updateDebug();
  }

  /** While dead: after 3 s, fire or jump respawns at the nearest cleared area (or spawn). */
  private deadTick(): void {
    const p = this.sim.player;
    const since = this.sim.time - p.diedAt;
    if (since < 3 || !(this.cmd.pressed & (Buttons.ATTACK | Buttons.JUMP))) return;
    const pcx = worldToChunk(p.move.pos.x);
    const pcz = worldToChunk(p.move.pos.z);
    let best = chunkKey(this.params.spawnCx, this.params.spawnCz);
    let bestD = Math.max(Math.abs(pcx - this.params.spawnCx), Math.abs(pcz - this.params.spawnCz));
    for (const key of this.sim.cleared) {
      const [cx, cz] = keyToCoords(key);
      const d = Math.max(Math.abs(pcx - cx), Math.abs(pcz - cz));
      if (d < bestD && this.streamer.resident.has(key)) {
        best = key;
        bestD = d;
      }
    }
    const [cx, cz] = keyToCoords(best);
    // Sidewalk on the chunk's west side: always walkable.
    const x = cx * CHUNK + 5;
    const z = cz * CHUNK + 14;
    this.sim.respawnPlayer(x, z);
    this.death = null;
    this.hud.showDeath(null);
    this.camCtl.bobY = 0;
  }

  private updateDeathView(dt: number): void {
    const p = this.sim.player;
    if (p.alive) {
      if (this.death) {
        this.death = null;
        this.hud.showDeath(null);
      }
      this.camCtl.bobY = 0;
      return;
    }
    const since = this.sim.time - p.diedAt;
    this.hud.showDeath(this.death?.text ?? 'You died', since >= 3 ? 'Click or press Space to respawn' : '');
    // Death cam: drop to the floor and turn to face the killer.
    this.camCtl.bobY = -Math.min(1, since * 2) * (eyeHeight(p.move) - 0.35);
    const k = this.death ? this.sim.getActor(this.death.killer) : undefined;
    if (k) {
      const dx = k.move.pos.x - p.move.pos.x;
      const dz = k.move.pos.z - p.move.pos.z;
      const dy = k.move.pos.y + 1.4 - (p.move.pos.y + 0.35);
      const yaw = Math.atan2(-dx, -dz);
      const pitch = Math.atan2(dy, Math.hypot(dx, dz));
      let d = yaw - this.input.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const t = 1 - Math.exp(-dt * 4);
      this.input.yaw += d * t;
      this.input.pitch += (pitch - this.input.pitch) * t;
    }
  }

  /** Any bot fighting within 40 m blocks buying. */
  private engagedNearby(): boolean {
    const p = this.sim.player.move.pos;
    return (
      this.encounters?.bots.some(
        (b) => b.actor.alive && b.state === 'engage' && Math.hypot(b.actor.move.pos.x - p.x, b.actor.move.pos.z - p.z) < 40,
      ) ?? false
    );
  }

  private updateHudExtras(): void {
    const p = this.sim.player;
    this.hud.setMoney(this.sim.economy.money);
    if (!p.alive && this.buyMenu.open) this.buyMenu.close();
    this.input.menuOpen = this.buyMenu.open;
    const zone = buyZoneStatus(this.sim, false);
    this.hud.setBuyHint(zone.ok && !this.buyMenu.open && this.params.world === 'city');
    if (this.buyMenu.open && (this.sim.tick & 15) === 0) this.buyMenu.render();
    if (this.encounters) {
      const marks = this.encounters.nearbyEncounters(p.move.pos.x, p.move.pos.z).map((e) => {
        const dx = (e.cx + 0.5) * CHUNK - p.move.pos.x;
        const dz = (e.cz + 0.5) * CHUNK - p.move.pos.z;
        return {
          angle: Math.atan2(-dx, -dz),
          label: `⚔${e.level}`,
          color: e.active ? '#ff6a5a' : '#ffc46a',
        };
      });
      this.hud.setCompass(marks, this.input.yaw);
    }
  }

  private updateDebug(): void {
    const f = this.debug.frameStats();
    const info = this.renderer.renderer.info;
    const p = this.sim.player;
    const m = p.move;
    const chunk = this.streamer.getChunkAt(m.pos.x, m.pos.z);
    this.debug.set([
      ['fps', `${f.fps.toFixed(0)}  (avg ${f.avg.toFixed(1)} ms, p99 ${f.p99.toFixed(1)}, max ${f.max.toFixed(1)})`],
      ['ticks/frame', `${this.loop.ticksLastFrame} @ ${this.params.tickRate} Hz`],
      ['draw calls', `${info.render.calls}`],
      ['triangles', `${(info.render.triangles / 1000).toFixed(1)}k`],
      ['geometries', `${info.memory.geometries}  textures ${info.memory.textures}  programs ${info.programs?.length ?? 0}`],
      ['', ''],
      ['chunks', `resident ${this.chunkRenderer.count}  visible ${this.chunkRenderer.visibleCount}  pending ${this.streamer.pending}`],
      ['gen ms', `last ${this.streamer.lastGenMs.toFixed(1)}  avg ${this.streamer.avgGenMs.toFixed(1)}  max ${this.streamer.maxGenMs.toFixed(1)}`],
      ['brushes', `${this.sim.world.brushCount}`],
      ['', ''],
      ['pos', `${m.pos.x.toFixed(2)} ${m.pos.y.toFixed(2)} ${m.pos.z.toFixed(2)}`],
      ['chunk', `${worldToChunk(m.pos.x)}, ${worldToChunk(m.pos.z)}  ${chunk ? DISTRICT_NAMES[chunk.district] : '-'}  lvl ${chunk?.level ?? '-'}`],
      ['speed', `${(Math.hypot(m.vel.x, m.vel.z) / HU).toFixed(0)} HU/s  vy ${(m.vel.y / HU).toFixed(0)}`],
      ['state', `${m.onGround ? 'ground' : 'air'}${m.ducked ? ' ducked' : ''}${m.noclip ? ' NOCLIP' : ''}  stuck ${m.stuckEvents}`],
      ['bots', `${this.encounters?.aliveCount ?? 0} alive  paths ${this.encounters?.pathQueries ?? 0}  snaps ${stuckSnaps}`],
      ['money', `$${this.sim.economy.money}  cleared ${this.sim.cleared.size}`],
      ['seed', this.params.seedText],
    ]);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    for (const d of this.disposers) d();
    this.input.dispose();
    this.streamer.dispose();
    this.presentation.dispose();
    this.audio.dispose();
    this.chunkRenderer.dispose();
    this.materials.dispose();
    this.renderer.dispose();
    this.ui.replaceChildren();
  }
}
