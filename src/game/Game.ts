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
import { Atmosphere } from '../render/Atmosphere';
import { Weather } from '../render/fx/Weather';
import { MASK_SHOT } from '../physics/brush';
import { makeTrace } from '../physics/trace';
import { teleport } from '../sim/Actor';
import { makeInventory } from '../weapons/Inventory';
import { Simulation } from '../sim/Simulation';
import { PickupManager } from '../sim/Pickups';
import { flashAmount } from '../sim/Grenades';
import { DebugOverlay } from '../ui/DebugOverlay';
import { Hud } from '../ui/Hud';
import { Minimap } from '../ui/Minimap';
import { WorldMap, type WorldMapView } from '../ui/WorldMap';
import { levelFor } from '../world/gen/district';
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
import { buy, buyZoneStatus, OUT_OF_COMBAT, priceOf, unavailableReason, type BuyItem } from '../sim/buy';
import { BuyMenu, itemName } from '../ui/BuyMenu';
import { SettingsMenu } from '../ui/SettingsMenu';
import { BUY_AMMO_KEYS, MAP_KEY, SLOT_KEYS } from '../input/bindings';
import { stuckSnaps } from '../ai/Bot';
import { Buttons } from '../input/UserCmd';
import { chunkKey, keyToCoords } from '../world/chunkMath';
import { WEAPONS, type WeaponId } from '../weapons/weaponDefs';
import { eyeHeight } from '../player/pmove';
import { describeSave, loadSave, writeSave } from '../core/saveStorage';
import { applyPlayerSave, applyWorldSave, captureSave, type SaveData } from '../sim/save';

type State = 'menu' | 'playing' | 'paused' | 'map';

export interface GameHooks {
  /** Throw this game away and start the saved one (the host rebuilds the Game). */
  loadSave(save: SaveData): void;
}

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
  private minimap: Minimap;
  private worldMap: WorldMap;
  private presentation: Presentation;
  private atmosphere: Atmosphere;
  private weather: Weather;
  private roofTrace = makeTrace();
  private roofFrom = new THREE.Vector3();
  private roofTo = new THREE.Vector3();
  readonly encounters: EncounterManager | null;
  readonly pickups: PickupManager;
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
  /** An area was cleared: save as soon as the fight is over. */
  private pendingAutosave = false;
  timeScale = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    private ui: HTMLElement,
    readonly params: GameParams,
    /** Saved game this one continues, or null for a fresh start. */
    private save: SaveData | null = null,
    private hooks: GameHooks | null = null,
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
    this.pickups = new PickupManager(this.sim);
    this.streamer.addListener(this.pickups);
    this.sim.systems.push(this.pickups);

    this.input = new Input(canvas);
    this.hud = new Hud(ui, this.settings);
    this.hud.setVisible(false);
    this.minimap = new Minimap(this.hud.root);
    this.streamer.addListener(this.minimap);
    this.worldMap = new WorldMap(ui, {
      seed: params.seed,
      levelAt: (cx, cz) => (params.level >= 0 ? params.level : levelFor(cx, cz)),
      fixedLevel: params.level >= 0 || params.world !== 'city',
      onClose: () => this.closeMap(),
    });
    this.streamer.addListener(this.worldMap);
    this.presentation = new Presentation(this.renderer, this.hud, this.camCtl, this.input, this.settings);
    this.presentation.pickups = this.pickups.items;
    this.atmosphere = new Atmosphere(this.renderer, this.materials);
    this.atmosphere.lampsEnabled = params.world === 'city';
    this.atmosphere.onLightning = (delay, strength) => this.sounds.thunder(delay, strength);
    this.weather = new Weather((x, z) => this.roofAt(x, z), this.presentation.particles);
    this.renderer.scene.add(this.weather.mesh);
    this.streamer.addListener({
      onChunkLoaded: () => this.weather.resetRoofs(),
      onChunkVisibility: () => {},
      onChunkUnloaded: (key) => {
        this.presentation.onChunkUnloaded(key);
        this.weather.resetRoofs();
      },
    });
    this.presentation.sinks.push(this.sounds);
    this.presentation.sinks.push({
      handle: (e) => {
        if (e.type === 'money') this.hud.flashMoney(e.amount);
        else if (e.type === 'chunkCleared') {
          this.hud.message(`AREA CLEARED  +$${e.bonus}  ·  buy zone unlocked`, 3.5);
          this.pendingAutosave = true;
        }
        else if (e.type === 'buy') {
          const text = e.ok ? `Bought ${itemName(e.item as BuyItem)}` : (e.reason ?? 'Cannot buy');
          this.buyMenu.feedback(text, e.ok);
          // Quick buys happen with the menu closed.
          if (!this.buyMenu.open) this.hud.message(text, 1.5);
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
      onSave: () => {
        const err = this.saveGame(true);
        this.menu.setStatus(err ?? 'Game saved.');
      },
      onLoad: () => {
        const save = loadSave();
        if (save && this.hooks) this.hooks.loadSave(save);
        else this.menu.setStatus('The save could not be read.');
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
        unavailable: (item) => unavailableReason(this.sim, item),
        slotWeapon: (slot) => this.sim.player.inv[slot]?.def.name ?? null,
        zone: () => buyZoneStatus(this.sim, this.engagedNearby()),
      },
      (item: BuyItem) => buy(this.sim, item, this.engagedNearby()),
    );
    this.menu.setSeed(params.seedText);
    this.refreshSaveInfo();
    // Progress, items and the map come back before any chunk streams in.
    if (save) {
      applyWorldSave(save, this.sim, this.pickups, this.encounters);
      this.worldMap.restoreExplored(save.explored);
    }

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
    this.audio.setMusicVolume(s.musicVolume);
    this.audio.setSfxVolume(s.sfxVolume);
    // URL parameters beat the settings for time of day and weather.
    const p = this.params;
    this.sim.envOverride = {
      hour: p.hour ?? (s.timeOfDay === 'day' ? 13 : s.timeOfDay === 'night' ? 0.5 : undefined),
      weather: p.weather ?? (s.weather === 'clear' ? 'clear' : undefined),
    };
    this.sim.updateEnv();
    if (this.weather) this.weather.density = s.rainParticles;
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
    } else if (this.save) {
      this.spawnX = this.save.player.x;
      this.spawnZ = this.save.player.z;
    } else {
      // City: the spawn plaza, just south of the fountain.
      this.spawnX = this.params.spawnCx * CHUNK + 32;
      this.spawnZ = this.params.spawnCz * CHUNK + 22;
    }
    teleport(this.sim.player, this.spawnX, 30, this.spawnZ);
    this.menu.setReady(false);
    this.menu.setStatus(this.save ? 'Loading your save…' : 'Generating the city…');
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
    } else if (this.save) {
      const s = this.save.player;
      teleport(p, s.x, this.sim.findFloor(s.x, s.z, s.y + 1), s.z);
      applyPlayerSave(s, p);
      this.input.yaw = s.yaw;
      this.input.pitch = s.pitch;
      this.menu.show('paused', 'SAVE LOADED');
    } else {
      this.input.yaw = Math.PI;
    }
    this.menu.setStatus('');
    this.menu.setReady(true);
  }

  /** Write the save slot. Returns why it couldn't, or null on success. */
  private saveGame(manual: boolean): string | null {
    if (this.params.world !== 'city') return 'Saving only works in the city.';
    if (this.loading) return 'Still loading.';
    if (!this.sim.player.alive) return 'You can’t save while dead.';
    if (manual && this.inCombat()) return 'You can’t save during a fight.';
    const data = captureSave(this.sim, this.pickups, this.encounters, this.worldMap.exploredKeys());
    if (!writeSave(data)) return 'Could not write the save (storage blocked or full).';
    this.pendingAutosave = false;
    this.refreshSaveInfo();
    return null;
  }

  private refreshSaveInfo(): void {
    const save = loadSave();
    this.menu.setSave(save ? describeSave(save) : null, this.params.world === 'city');
  }

  /** Autosave after an area is cleared, once the player is alive and out of combat. */
  private autosave(): void {
    if (!this.pendingAutosave || this.state !== 'playing' || !this.sim.player.alive || this.inCombat()) return;
    if (this.saveGame(false) === null) this.hud.message('Game saved', 1.5);
    else this.pendingAutosave = false;
  }

  private bindEvents(): void {
    const onResize = () => this.renderer.resize();
    window.addEventListener('resize', onResize);
    this.disposers.push(() => window.removeEventListener('resize', onResize));

    const onLockChange = () => {
      if (document.pointerLockElement === this.canvas) {
        this.state = 'playing';
        this.menu.hide();
        this.worldMap.hide();
        this.hud.setVisible(true);
        this.loop.reset();
        this.audio.setMusicPaused(false);
      } else if (this.state === 'playing') {
        this.pause();
      }
    };
    const onLockError = () => {
      if (this.state === 'map') this.worldMap.setStatus('Could not capture the mouse — click Close again.');
      else this.menu.setStatus('Could not capture the mouse — click Resume again.');
    };
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
        if (this.state === 'map') {
          if (code === MAP_KEY || code === 'Escape') this.closeMap();
          else if (code === 'KeyC') this.worldMap.recenter();
          return;
        }
        if (this.state === 'playing' && code === MAP_KEY) {
          this.openMap();
          return;
        }
        if (this.state === 'playing' && this.sim.player.alive) {
          if (code === 'KeyB') this.buyMenu.toggle();
          else if (this.buyMenu.open && code in SLOT_KEYS) this.buyMenu.select(SLOT_KEYS[code]);
          else if (code in BUY_AMMO_KEYS) buy(this.sim, BUY_AMMO_KEYS[code], this.engagedNearby());
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
    this.refreshSaveInfo();
    this.audio.setMusicPaused(true);
    this.buyMenu.close();
    this.menu.show('paused');
    this.input.keyboardLocked = !!document.fullscreenElement && this.input.keyboardLocked;
  }

  /** Full-screen map: pauses the game and hands the mouse back for panning. */
  private openMap(): void {
    this.state = 'map';
    this.buyMenu.close();
    this.audio.setMusicPaused(true);
    this.worldMap.show(this.mapView());
    // State is already 'map', so losing the lock doesn't open the pause menu.
    this.input.exitLock();
  }

  /** Back to the game once the mouse is captured again (see the pointerlockchange handler). */
  private closeMap(): void {
    this.worldMap.setStatus('');
    this.input.requestLock().catch(() => this.worldMap.setStatus('Could not capture the mouse — click Close again.'));
  }

  private mapView(): WorldMapView {
    const pos = this.sim.player.move.pos;
    return {
      x: pos.x,
      z: pos.z,
      yaw: this.input.yaw,
      spawnCx: this.params.spawnCx,
      spawnCz: this.params.spawnCz,
      cleared: this.sim.cleared,
      encounters: [...(this.encounters?.states.values() ?? [])].map((s) => ({
        cx: s.cx,
        cz: s.cz,
        level: s.level,
        cleared: s.cleared,
        active: !!s.squad,
      })),
      stash: this.pickups.stashPos,
    };
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
    const env = this.sim.env;
    this.atmosphere.update(env, frameMs / 1000, cam, p.alive && p.flashlight);
    this.presentation.setWorldLight(this.atmosphere.viewmodelLight, env.daylight);
    this.presentation.torches = this.botTorches(env.darkness);
    this.weather.update(env.rain, Math.min(frameMs / 1000, 0.1), cam.position);
    this.audio.setAmbience(env.rain, env.darkness, this.roofAt(cam.position.x, cam.position.z) > cam.position.y + 0.3);
    // Audio listener follows the camera.
    cam.getWorldDirection(this.fwd);
    this.up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    this.sounds.listener.x = cam.position.x;
    this.sounds.listener.y = cam.position.y;
    this.sounds.listener.z = cam.position.z;
    this.audio.setListener(cam.position.x, cam.position.y, cam.position.z, this.fwd.x, this.fwd.y, this.fwd.z, this.up.x, this.up.y, this.up.z);
    this.sounds.tick(frameMs / 1000);
    this.sounds.fires(this.sim);
    this.audio.setDeafen(this.sim.player.alive ? Math.min(1, flashAmount(this.sim.player, this.sim.time) * 1.2) : 0);
    this.audio.setMusicIntensity(this.inCombat() ? 1 : 0);
    this.audio.updateMusic();
    this.presentation.handleEvents(this.sim);
    this.focus.set(this.camCtl.position.x, 0, this.camCtl.position.z);
    this.renderer.updateSun(this.focus);
    this.renderer.render();

    this.updateHudExtras();
    this.autosave();
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

  /** Fighting right now: bots engaging nearby, or damage taken/dealt recently. Drives the music. */
  private inCombat(): boolean {
    const p = this.sim.player;
    if (!p.alive) return false;
    const t = this.sim.time;
    return t - p.lastDamagedAt < OUT_OF_COMBAT || t - p.lastDealtAt < OUT_OF_COMBAT || this.engagedNearby();
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
    const swap = this.pickups.swapCandidate;
    let prompt: string | null = null;
    if (swap?.item.kind === 'weapon' && p.alive) {
      const def = WEAPONS[swap.item.weapon];
      const cur = p.inv[def.slot];
      prompt = cur ? `Swap ${cur.def.name} for ${def.name}` : `Pick up ${def.name}`;
    }
    this.hud.setPrompt(prompt);
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
    this.updateMinimap();
  }

  private updateMinimap(): void {
    const pos = this.sim.player.move.pos;
    const encounters = this.encounters;
    this.minimap.draw({
      x: pos.x,
      z: pos.z,
      yaw: this.input.yaw,
      buyZones: new Set([chunkKey(this.params.spawnCx, this.params.spawnCz), ...this.sim.cleared]),
      showZones: this.params.world === 'city',
      encounters: encounters?.nearbyEncounters(pos.x, pos.z) ?? [],
      // Only bots that are fighting you show up: no free wallhacks.
      enemies: encounters?.bots.filter((b) => b.actor.alive && b.state === 'engage').map((b) => b.actor.move.pos) ?? [],
      pickups: this.pickups.items,
      stash: this.pickups.stashPos,
    });
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

  private torchSet = new Set<number>();
  /** After dark, bots that are moving about or hunting you carry a lit flashlight. */
  private botTorches(darkness: number): ReadonlySet<number> {
    const set = this.torchSet;
    set.clear();
    if (darkness < 0.25 || !this.encounters) return set;
    for (const b of this.encounters.bots) {
      if (b.actor.alive && b.state !== 'idle' && b.state !== 'overwatch') set.add(b.actor.id);
    }
    return set;
  }

  /** Height of the first surface below the open sky at (x, z), or -Infinity over nothing. */
  private roofAt(x: number, z: number): number {
    this.roofFrom.set(x, 90, z);
    this.roofTo.set(x, -40, z);
    this.sim.world.traceRay(this.roofTrace, this.roofFrom, this.roofTo, MASK_SHOT);
    return this.roofTrace.fraction < 1 ? this.roofTrace.endY : -Infinity;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.worldMap.hide();
    for (const d of this.disposers) d();
    this.input.dispose();
    this.streamer.dispose();
    this.presentation.dispose();
    this.atmosphere.dispose();
    this.weather.dispose();
    this.audio.dispose();
    this.chunkRenderer.dispose();
    this.materials.dispose();
    this.renderer.dispose();
    this.ui.replaceChildren();
  }
}
