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

    this.input = new Input(canvas);
    this.hud = new Hud(ui, this.settings);
    this.hud.setVisible(false);
    this.presentation = new Presentation(this.renderer, this.hud, this.camCtl, this.input, this.settings);
    this.streamer.addListener({
      onChunkLoaded: () => {},
      onChunkVisibility: () => {},
      onChunkUnloaded: (key) => this.presentation.onChunkUnloaded(key),
    });
    this.debug = new DebugOverlay(ui, params.debug || this.settings.showFps);
    this.menu = new MainMenu(ui, {
      onPlay: (fs) => void this.play(fs),
      onSettings: () => this.menu.setStatus('Settings arrive in a later milestone.'),
    });
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
    saveSettings(s);
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
        if (!this.params.debug && this.params.world !== 'gym') return;
        if (code === DEBUG_KEYS.noclip) this.sim.player.move.noclip = !this.sim.player.move.noclip;
        if (code === DEBUG_KEYS.slowmo) this.timeScale = this.timeScale === 1 ? 0.25 : 1;
      }),
    );
  }

  private async play(fullscreen: boolean): Promise<void> {
    if (this.loading) return;
    this.menu.setStatus('');
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
        });
      }
    }

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
    this.presentation.handleEvents(this.sim);
    this.focus.set(this.camCtl.position.x, 0, this.camCtl.position.z);
    this.renderer.updateSun(this.focus);
    this.renderer.render();

    this.debug.frame(frameMs);
    this.debug.setSpeed(Math.hypot(p.move.vel.x, p.move.vel.z) / HU, p.move.onGround);
    if (this.debug.due(now)) this.updateDebug();
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
      ['seed', this.params.seedText],
    ]);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    for (const d of this.disposers) d();
    this.input.dispose();
    this.streamer.dispose();
    this.presentation.dispose();
    this.chunkRenderer.dispose();
    this.materials.dispose();
    this.renderer.dispose();
    this.ui.replaceChildren();
  }
}
