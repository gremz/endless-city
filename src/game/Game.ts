import * as THREE from 'three';
import { CHUNK, HU } from '../core/config';
import { FixedLoop } from '../core/loop';
import { loadSettings, saveSettings, type Settings } from '../core/settings';
import type { GameParams } from '../core/urlParams';
import { DEBUG_KEYS } from '../input/bindings';
import { Input } from '../input/Input';
import { makeCmd } from '../input/UserCmd';
import { CameraController } from '../player/CameraController';
import type { EngineSource } from '../audio/Engines';
import type { Vehicle } from '../sim/vehicle/Vehicle';
import { ChunkRenderer } from '../render/ChunkRenderer';
import { MaterialLibrary } from '../render/materials';
import { Renderer } from '../render/Renderer';
import { Atmosphere } from '../render/Atmosphere';
import { Weather } from '../render/fx/Weather';
import { MASK_SHOT } from '../physics/brush';
import { makeTrace } from '../physics/trace';
import { Team, teleport, type Actor } from '../sim/Actor';
import { makeInventory } from '../weapons/Inventory';
import { Simulation } from '../sim/Simulation';
import { PickupManager } from '../sim/Pickups';
import { flashAmount } from '../sim/Grenades';
import { DebugOverlay } from '../ui/DebugOverlay';
import { Hud } from '../ui/Hud';
import { Minimap } from '../ui/Minimap';
import { NameTags } from '../ui/NameTags';
import { Chat } from '../ui/Chat';
import { Scoreboard } from '../ui/Scoreboard';
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
import { buy, buyZoneStatus, engagedNear, OUT_OF_COMBAT, priceOf, unavailableReason, type BuyItem } from '../sim/buy';
import { BuyMenu, itemName } from '../ui/BuyMenu';
import { SettingsMenu } from '../ui/SettingsMenu';
import { BUY_AMMO_KEYS, MAP_KEY, SLOT_KEYS } from '../input/bindings';
import { stuckSnaps } from '../ai/Bot';
import { Buttons } from '../input/UserCmd';
import { chunkKey } from '../world/chunkMath';
import { WEAPONS, type WeaponId } from '../weapons/weaponDefs';
import { eyeHeight } from '../player/pmove';
import { describeSave, loadSave, writeSave } from '../core/saveStorage';
import { RESPAWN_DELAY, respawnPoint } from '../sim/respawn';
import { Mirror } from '../net/Mirror';
import type { NetClient } from '../net/NetClient';
import { Prediction } from '../net/Prediction';
import { applyPlayerSave, applyWorldSave, captureSave, type SaveData } from '../sim/save';
import { VehicleRenderer } from '../render/VehicleRenderer';
import { carSpeed, forwardSpeed } from '../sim/vehicle/carPhysics';
import { enterableVehicle } from '../sim/vehicle/Vehicle';
import { Vehicles } from '../sim/vehicle/Vehicles';
import { CHASE_PITCH_MAX, CHASE_PITCH_MIN } from '../player/CameraController';

type State = 'menu' | 'playing' | 'paused' | 'map';

export interface GameHooks {
  /** Throw this game away and start the saved one (the host rebuilds the Game). */
  loadSave(save: SaveData): void;
  /** Host a co-op game (from the title screen), in a new city or continuing the save. */
  host?(name: string, fromSave: boolean): void;
  /** Join a co-op game by room code or invite link. */
  join?(code: string, name: string): void;
}

/** A co-op game: this screen mirrors the host's simulation instead of running its own. */
export interface OnlineGame {
  net: NetClient;
  /** Room code friends join with (shown to everyone), or null. */
  code: string | null;
  /** This player is the host (leaving ends the game for everyone). */
  host: boolean;
  /** Leave the game (menu button, or the connection dropped with `reason`). */
  leave(reason?: string): void;
  /** Host only: write the save slot from the host's game. Resolves with why it failed, or null. */
  save?(explored: number[], manual: boolean): Promise<string | null>;
}

interface KeyboardLock {
  lock(keys?: string[]): Promise<void>;
  unlock(): void;
}

/** Composition root: wires simulation, streaming, rendering, input and UI, and owns the frame loop. */
export class Game {
  readonly sim: Simulation;
  /** The player at this screen. */
  readonly me: Actor;
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
  private nameTags: NameTags | null = null;
  private chat: Chat | null = null;
  private scoreboard: Scoreboard | null = null;
  private scores = new Map<number, { kills: number; deaths: number; money: number }>();
  private worldMap: WorldMap;
  private presentation: Presentation;
  private atmosphere: Atmosphere;
  private weather: Weather;
  private roofTrace = makeTrace();
  private roofFrom = new THREE.Vector3();
  private roofTo = new THREE.Vector3();
  readonly encounters: EncounterManager | null;
  readonly pickups: PickupManager;
  /** Car lifecycle (null online: the host runs it). */
  readonly vehicles: Vehicles | null = null;
  private vehicleRenderer: VehicleRenderer;
  /** Id of the car we were driving last frame (-1 on foot). */
  private drivingId = -1;
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
  private mirror: Mirror | null = null;
  private prediction: Prediction | null = null;
  private gotSnapshot = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private ui: HTMLElement,
    readonly params: GameParams,
    /** Saved game this one continues, or null for a fresh start. */
    private save: SaveData | null = null,
    private hooks: GameHooks | null = null,
    readonly online: OnlineGame | null = null,
  ) {
    this.settings = loadSettings();
    const tickDt = 1 / params.tickRate;
    this.loop = new FixedLoop(tickDt);
    this.sim = new Simulation(params, { autoBhop: this.settings.autoBhop }, tickDt);
    this.me = this.sim.player;
    if (online) {
      // Our actor on the host.
      this.me.id = online.net.actorId;
      this.me.name = online.net.name;
    }
    this.sounds.localId = this.me.id;

    this.renderer = new Renderer(canvas);
    this.materials = new MaterialLibrary(this.renderer.anisotropy);
    this.chunkRenderer = new ChunkRenderer(this.materials, this.settings.shadows > 0);
    this.renderer.scene.add(this.chunkRenderer.root);
    this.vehicleRenderer = new VehicleRenderer(this.materials, this.settings.shadows > 0);
    this.renderer.scene.add(this.vehicleRenderer.root);

    const source: ChunkSource =
      params.world === 'city'
        ? new WorkerChunkSource(params.seed, 'city', generateChunk)
        : new SyncChunkSource(params.seed, generateGymChunk);
    this.streamer = new WorldStreamer(this.sim.world, source);
    this.streamer.addListener(this.chunkRenderer);
    this.streamer.addListener(this.sim.nav);
    this.encounters = params.world === 'city' ? new EncounterManager(this.sim, this.streamer) : null;
    this.pickups = new PickupManager(this.sim);
    if (online) {
      // Bots and items live on the host; they only show up here.
      this.mirror = new Mirror(this.sim, this.me.id, this.pickups, this.encounters, true);
      this.prediction = new Prediction(this.sim, this.me);
    } else {
      if (this.encounters) this.sim.systems.push(this.encounters);
      this.streamer.addListener(this.pickups);
      this.sim.systems.push(this.pickups);
      this.vehicles = new Vehicles(this.sim);
      this.streamer.addListener(this.vehicles);
      this.sim.systems.push(this.vehicles);
    }

    this.input = new Input(canvas);
    this.hud = new Hud(ui, this.settings);
    this.hud.setVisible(false);
    this.minimap = new Minimap(this.hud.root);
    if (online) {
      this.nameTags = new NameTags(this.hud.root);
      this.scoreboard = new Scoreboard(this.hud.root);
      this.chat = new Chat(
        this.hud.root,
        (text) => online.net.sendChat(text),
        (open) => {
          // Typing shouldn't walk you around.
          this.input.enabled = !open;
        },
      );
    }
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
    this.presentation.localId = this.me.id;
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
        if (e.type === 'money') {
          if (e.actorId === this.me.id) this.hud.flashMoney(e.amount);
        }
        else if (e.type === 'chunkCleared') {
          this.hud.message(`AREA CLEARED  +$${e.bonus}  ·  buy zone unlocked`, 3.5);
          this.pendingAutosave = true;
        }
        else if (e.type === 'buy' && e.actorId === this.me.id) {
          const text = e.ok ? `Bought ${itemName(e.item as BuyItem)}` : (e.reason ?? 'Cannot buy');
          this.buyMenu.feedback(text, e.ok);
          // Quick buys happen with the menu closed.
          if (!this.buyMenu.open) this.hud.message(text, 1.5);
        }
        else if (e.type === 'kill' && e.victimId === this.me.id) {
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
        if (this.online?.save) {
          this.menu.setStatus('Saving…');
          void this.online.save(this.worldMap.exploredKeys(), true).then((err) => {
            this.menu.setStatus(err ?? 'Game saved.');
            if (!err) this.refreshSaveInfo();
          });
          return;
        }
        const err = this.saveGame(true);
        this.menu.setStatus(err ?? 'Game saved.');
      },
      onLoad: () => {
        const save = loadSave();
        if (save && this.hooks) this.hooks.loadSave(save);
        else this.menu.setStatus('The save could not be read.');
      },
      onHost: (name, fromSave) => this.hooks?.host?.(name, fromSave),
      onJoin: (code, name) => this.hooks?.join?.(code, name),
      onLeave: () => this.online?.leave(),
    });
    if (online) this.menu.setOnline(online.code, online.host);
    else this.menu.setCoop(params.world === 'city' && !!hooks?.host);
    this.settingsMenu = new SettingsMenu(
      ui,
      this.settings,
      () => this.applySettings(),
      () => {
        this.settingsMenu.hide();
        this.menu.show(this.state === 'menu' ? 'title' : 'paused');
      },
    );
    const me = this.me;
    this.buyMenu = new BuyMenu(
      ui,
      {
        get money() {
          return me.money;
        },
        price: (item) => priceOf(me, item),
        unavailable: (item) => unavailableReason(me, item),
        slotWeapon: (slot) => me.inv[slot]?.def.name ?? null,
        zone: () => buyZoneStatus(this.sim, me, this.engagedNearby()),
      },
      (item: BuyItem) => this.buy(item),
    );
    this.menu.setSeed(params.seedText);
    this.refreshSaveInfo();
    // Progress, items and the map come back before any chunk streams in.
    if (save) {
      // Online, the host's worker restored the world; only our map is ours.
      if (!online) applyWorldSave(save, this.sim, this.pickups, this.encounters, this.vehicles, this.me.id);
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
    this.vehicleRenderer?.setShadows(s.shadows > 0);
    this.sim.opts.autoBhop = s.autoBhop;
    this.audio.setVolume(s.masterVolume);
    this.audio.setMusicVolume(s.musicVolume);
    this.audio.setSfxVolume(s.sfxVolume);
    // URL parameters beat the settings for time of day and weather. Online, the host decides.
    const p = this.params;
    this.sim.envOverride = this.online
      ? { hour: p.hour ?? undefined, weather: p.weather ?? undefined }
      : {
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
    if (this.online) {
      // The host places us; we learn where from the first snapshot.
      this.menu.setReady(false);
      this.menu.setStatus('Joining…');
      return;
    }
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
    teleport(this.me, this.spawnX, 30, this.spawnZ);
    this.menu.setReady(false);
    this.menu.setStatus(this.save ? 'Loading your save…' : 'Generating the city…');
  }

  private finishSpawn(): void {
    this.loading = false;
    const p = this.me;
    if (this.online) {
      this.input.yaw = p.yaw;
      this.input.pitch = 0;
      this.menu.setStatus('');
      this.menu.setReady(true);
      return;
    }
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
      applyPlayerSave(s, p, this.save.money);
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
    if (this.online) return 'Saving is not available in co-op games.';
    if (this.params.world !== 'city') return 'Saving only works in the city.';
    if (this.loading) return 'Still loading.';
    if (!this.me.alive) return 'You can’t save while dead.';
    if (manual && this.inCombat()) return 'You can’t save during a fight.';
    if (this.me.vehicle >= 0) return 'Get out of the car to save.';
    const data = captureSave(this.sim, this.me, this.pickups, this.encounters, this.vehicles, this.worldMap.exploredKeys());
    if (!writeSave(data)) return 'Could not write the save (storage blocked or full).';
    this.pendingAutosave = false;
    this.refreshSaveInfo();
    return null;
  }

  private refreshSaveInfo(): void {
    if (this.online) {
      // The host can save the co-op game; loading happens from the title screen.
      const save = this.online.save ? loadSave() : null;
      this.menu.setSave(save ? describeSave(save) : null, !!this.online.save, false);
      return;
    }
    const save = loadSave();
    this.menu.setSave(save ? describeSave(save) : null, this.params.world === 'city');
  }

  /** Autosave after an area is cleared, once the player is alive and out of combat. */
  private autosave(): void {
    if (this.online?.save) {
      if (!this.pendingAutosave || !this.me.alive || this.inCombat() || this.me.vehicle >= 0) return;
      // The host saves the shared progress after a clear, once the fight is over.
      this.pendingAutosave = false;
      void this.online.save(this.worldMap.exploredKeys(), false).then((err) => {
        if (!err) this.hud.message('Game saved', 1.5);
      });
      return;
    }
    if (this.online) return;
    // Waits until the player is out of the fight (and out of the car).
    if (!this.pendingAutosave || this.state !== 'playing' || !this.me.alive || this.inCombat() || this.me.vehicle >= 0) return;
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
        if (this.chat?.open) return;
        if (code === DEBUG_KEYS.overlay) this.debug.toggle();
        if (this.chat && this.state === 'playing' && code === 'Enter') {
          this.chat.show();
          return;
        }
        if (this.state === 'map') {
          if (code === MAP_KEY || code === 'Escape') this.closeMap();
          else if (code === 'KeyC') this.worldMap.recenter();
          return;
        }
        if (this.state === 'playing' && code === MAP_KEY) {
          this.openMap();
          return;
        }
        if (this.state === 'playing' && this.me.alive) {
          if (code === 'KeyB') this.buyMenu.toggle();
          else if (this.buyMenu.open && code in SLOT_KEYS) this.buyMenu.select(SLOT_KEYS[code]);
          else if (code in BUY_AMMO_KEYS) this.buy(BUY_AMMO_KEYS[code]);
        }
        if ((!this.params.debug && this.params.world !== 'gym') || this.online) return;
        if (code === DEBUG_KEYS.noclip) this.me.move.noclip = !this.me.move.noclip;
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
    const pos = this.me.move.pos;
    return {
      x: pos.x,
      z: pos.z,
      yaw: this.input.yaw,
      spawnCx: this.params.spawnCx,
      spawnCz: this.params.spawnCz,
      cleared: this.sim.cleared,
      encounters: this.encounters?.summaries() ?? [],
      stash: this.pickups.stashPos(this.me.id),
      allies: this.allies().map((a) => ({ x: a.move.pos.x, z: a.move.pos.z, alive: a.alive, name: a.name })),
    };
  }

  /** The other players in a co-op game. */
  private allies(): Actor[] {
    return this.sim.players.filter((a) => a !== this.me);
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
    const frameMs = Math.max(0, now - this.lastFrame);
    this.lastFrame = now;
    const dt = Math.min(frameMs / 1000, 0.25) * this.timeScale;
    const p = this.me;

    let alpha = 1;
    if (this.online) {
      alpha = this.onlineTick(frameMs / 1000, now);
    } else if (this.state === 'playing') {
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

    if (this.online && this.loading) {
      // Wait for the host to tell us where we are, then for the city around it.
      if (this.gotSnapshot) {
        this.spawnX = p.move.pos.x;
        this.spawnZ = p.move.pos.z;
        this.streamer.update(this.spawnX, this.spawnZ, this.input.yaw);
        this.streamer.apply(4, 2);
        if (this.streamer.allLoaded(this.spawnX, this.spawnZ, 1)) this.finishSpawn();
      }
    } else if (this.loading) {
      this.streamer.update(this.spawnX, this.spawnZ, this.input.yaw);
      this.streamer.apply(4, 2);
      if (this.streamer.allLoaded(this.spawnX, this.spawnZ, 1)) this.finishSpawn();
    } else {
      this.streamer.update(p.move.pos.x, p.move.pos.z, this.input.yaw);
      this.streamer.apply(1);
    }

    this.presentation.update(this.sim, alpha, frameMs / 1000);
    const cam = this.renderer.camera;
    const car = p.alive ? this.sim.vehicleOf(p) : undefined;
    if (car) {
      this.steerView(car, frameMs / 1000);
      this.camCtl.chase(cam, car, alpha, this.input.yaw, this.input.pitch, this.sim.world);
    } else {
      this.drivingId = -1;
      this.camCtl.update(cam, p, alpha, this.input.yaw, this.input.pitch);
    }
    const env = this.sim.env;
    this.vehicleRenderer.update(this.sim.vehicles, alpha, this.sim.time, frameMs / 1000, car?.id ?? -1, env.darkness);
    this.atmosphere.update(env, frameMs / 1000, cam, p.alive && p.flashlight && !car);
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
    this.audio.setEngines(this.engineSources());
    this.audio.setDeafen(this.me.alive ? Math.min(1, flashAmount(this.me, this.sim.time) * 1.2) : 0);
    this.audio.setMusicIntensity(this.inCombat() ? 1 : 0);
    this.audio.updateMusic();
    this.presentation.handleEvents(this.sim);
    this.focus.set(this.camCtl.position.x, 0, this.camCtl.position.z);
    this.renderer.updateSun(this.focus);
    this.renderer.render();
    this.nameTags?.update(cam, this.allies());

    this.updateHudExtras();
    this.updateCoopHud(now / 1000);
    if (this.online && this.state !== 'playing' && (this.sim.tick & 31) === 0) this.menu.setPlayers(this.sim.players.map((a) => a.name));
    this.autosave();
    this.debug.frame(frameMs);
    this.debug.setSpeed(Math.hypot(p.move.vel.x, p.move.vel.z) / HU, p.move.onGround);
    if (this.debug.due(now)) this.updateDebug();
  }

  /**
   * Chase-camera housekeeping: face forward on getting in, keep the pitch in the chase range,
   * and swing the view back behind the car while driving with the mouse left alone.
   */
  private steerView(car: Vehicle, dt: number): void {
    const input = this.input;
    if (this.drivingId !== car.id) {
      this.drivingId = car.id;
      input.yaw = car.car.yaw;
      input.pitch = 0;
    }
    input.pitch = Math.max(CHASE_PITCH_MIN, Math.min(CHASE_PITCH_MAX, input.pitch));
    if (performance.now() - input.lastLook > 1000) input.yaw = CameraController.recenter(input.yaw, car.car.yaw, forwardSpeed(car.car), dt);
  }

  /** Engines running near the camera, nearest first. */
  private engineSources(): EngineSource[] {
    const L = this.sounds.listener;
    const out: (EngineSource & { d: number })[] = [];
    for (const v of this.sim.vehicles) {
      if (v.driver < 0 || v.destroyed) continue;
      const c = v.car;
      const d = Math.hypot(c.pos.x - L.x, c.pos.z - L.z);
      if (d > 90) continue;
      out.push({ id: v.id, x: c.pos.x, y: c.pos.y + 0.6, z: c.pos.z, speed: carSpeed(c), load: Math.abs(c.throttle), d });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  /** While dead: after 3 s, fire or jump respawns at the nearest cleared area (or spawn). */
  private deadTick(): void {
    const p = this.me;
    const since = this.sim.time - p.diedAt;
    if (since < RESPAWN_DELAY || !(this.cmd.pressed & (Buttons.ATTACK | Buttons.JUMP))) return;
    const { x, z } = respawnPoint(this.sim, p, (key) => this.streamer.resident.has(key));
    this.sim.respawnPlayer(this.me, x, z);
    this.death = null;
    this.hud.showDeath(null);
    this.camCtl.bobY = 0;
  }

  private updateDeathView(dt: number): void {
    const p = this.me;
    if (p.alive) {
      if (this.death) {
        this.death = null;
        this.hud.showDeath(null);
      }
      this.camCtl.bobY = 0;
      return;
    }
    const since = this.sim.time - p.diedAt;
    this.hud.showDeath(this.death?.text ?? 'You died', since >= RESPAWN_DELAY ? 'Click or press Space to respawn' : '');
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
    const p = this.me;
    if (!p.alive) return false;
    const t = this.sim.time;
    return t - p.lastDamagedAt < OUT_OF_COMBAT || t - p.lastDealtAt < OUT_OF_COMBAT || this.engagedNearby();
  }

  /** Any bot fighting within 40 m blocks buying. */
  private engagedNearby(): boolean {
    return engagedNear(this.sim, this.me);
  }

  private updateHudExtras(): void {
    const p = this.me;
    this.hud.setMoney(p.money);
    if (!p.alive && this.buyMenu.open) this.buyMenu.close();
    this.input.menuOpen = this.buyMenu.open;
    const zone = buyZoneStatus(this.sim, p, false);
    this.hud.setBuyHint(zone.ok && !this.buyMenu.open && this.params.world === 'city');
    const swap = this.pickups.swapCandidate(p.id);
    let prompt: string | null = null;
    // E gets into a car before it swaps guns.
    if (enterableVehicle(this.sim, p)) prompt = 'Drive';
    else if (swap?.item.kind === 'weapon' && p.alive && p.vehicle < 0) {
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
    const pos = this.me.move.pos;
    const encounters = this.encounters;
    this.minimap.draw({
      x: pos.x,
      z: pos.z,
      yaw: this.input.yaw,
      buyZones: new Set([chunkKey(this.params.spawnCx, this.params.spawnCz), ...this.sim.cleared]),
      showZones: this.params.world === 'city',
      encounters: encounters?.nearbyEncounters(pos.x, pos.z) ?? [],
      // Only bots that are fighting you show up: no free wallhacks.
      enemies: this.sim.actors.filter((a) => a.alive && a.engaging).map((a) => a.move.pos),
      allies: this.allies().map((a) => ({ x: a.move.pos.x, z: a.move.pos.z, alive: a.alive })),
      pickups: this.pickups.items,
      stash: this.pickups.stashPos(this.me.id),
      cars: this.sim.vehicles.filter((v) => !v.destroyed && v.driver < 0).map((v) => ({ x: v.car.pos.x, z: v.car.pos.z, yaw: v.car.yaw })),
    });
  }

  private updateDebug(): void {
    const f = this.debug.frameStats();
    const info = this.renderer.renderer.info;
    const p = this.me;
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
      ['money', `$${p.money}  cleared ${this.sim.cleared.size}`],
      ['cars', this.carDebug()],
      ...this.netDebug(),
      ['seed', this.params.seedText],
    ]);
  }

  private torchSet = new Set<number>();
  /** After dark, bots that are moving about or hunting you carry a lit flashlight. */
  private botTorches(darkness: number): ReadonlySet<number> {
    const set = this.torchSet;
    set.clear();
    if (darkness < 0.25) return set;
    for (const a of this.sim.actors) {
      if (a.alive && a.flashlight && a.team === Team.Bots) set.add(a.id);
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

  /** Buy through the host online, directly in a local game. */
  /** Message on the title/pause menu (connection progress and errors). */
  setMenuStatus(text: string, busy = false): void {
    this.menu.setStatus(text);
    this.menu.setBusy(busy);
  }

  private buy(item: BuyItem): void {
    if (this.online) this.online.net.sendBuy(item);
    else buy(this.sim, this.me, item, this.engagedNearby());
  }

  /**
   * Online frame: apply what the host sent (re-predicting our own player on top of it), send and
   * predict one command per tick, and place everyone else between snapshots. Returns the
   * interpolation alpha for our own (predicted) player.
   */
  private onlineTick(frameDt: number, now: number): number {
    const online = this.online!;
    const net = online.net;
    const mirror = this.mirror!;
    const prediction = this.prediction!;
    const me = this.me;
    if (!net.connected) {
      online.leave(net.closedReason ?? 'Disconnected');
      return 1;
    }
    for (const m of net.takeMessages()) {
      if (mirror.applyMessage(m)) continue;
      if (m.t === 'chat') this.chat?.add(m.from, m.text, now / 1000);
      else if (m.t === 'scores') {
        this.scores.clear();
        for (const [id, , kills, deaths, money] of m.s) this.scores.set(id, { kills, deaths, money });
      }
    }
    prediction.active = !this.loading && this.streamer.isLoaded(me.move.pos.x, me.move.pos.z);
    const snap = net.takeSnapshot();
    const seconds = now / 1000;
    if (snap) {
      const { x, y, z } = me.move.pos;
      mirror.applySnapshot(snap, seconds);
      prediction.reconcile(snap.ackCmd, snap.tick, snap.time, x, y, z);
      this.gotSnapshot = true;
    }
    const alpha = this.loop.advance(frameDt, () => {
      // Menus and maps release the mouse; buildCmd then sends an idle command.
      this.input.buildCmd(this.cmd);
      const seq = net.sendCmd(this.cmd, mirror.renderTime(seconds));
      if (this.gotSnapshot) prediction.predict(seq, this.cmd);
    });
    mirror.interpolate(mirror.renderTime(seconds));
    return alpha;
  }

  /** Chat fading and the Tab scoreboard (co-op). */
  private updateCoopHud(now: number): void {
    this.chat?.update(now);
    const board = this.scoreboard;
    if (!board) return;
    const show = this.state === 'playing' && this.input.isHeld('Tab') && !this.chat?.open;
    board.setVisible(show);
    if (!show) return;
    const rows = this.sim.players.map((p) => {
      const s = this.scores.get(p.id);
      return { id: p.id, name: p.name, kills: s?.kills ?? 0, deaths: s?.deaths ?? 0, money: p === this.me ? p.money : (s?.money ?? 0), alive: p.alive };
    });
    rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    const code = this.online?.code ? `  ·  ROOM ${this.online.code}` : '';
    board.render(`CO-OP  ·  ${rows.length} PLAYER${rows.length === 1 ? '' : 'S'}${code}`, rows, this.me.id);
  }

  private carDebug(): string {
    const v = this.sim.vehicleOf(this.me);
    const n = `${this.sim.vehicles.length} loaded`;
    if (!v) return n;
    const c = v.car;
    return `${n}  driving #${v.id}  ${(carSpeed(c) * 3.6).toFixed(0)} km/h  hp ${Math.ceil(v.health)}  ${c.onGround ? 'ground' : 'air'}`;
  }

  private netDebug(): [string, string][] {
    const net = this.online?.net;
    if (!net) return [];
    return [
      ['net', `rtt ${net.rtt.toFixed(0)} ms  snaps ${net.snapshotsIn}  in ${(net.bytesIn / 1024).toFixed(0)} KB  out ${(net.bytesOut / 1024).toFixed(0)} KB`],
      ['predict', `corrections ${this.prediction?.corrections ?? 0}  last ${(this.prediction?.lastError ?? 0).toFixed(3)} m`],
      ['players', this.sim.players.map((p) => p.name).join(', ')],
    ];
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
    this.vehicleRenderer.dispose();
    this.materials.dispose();
    this.renderer.dispose();
    this.ui.replaceChildren();
  }
}
