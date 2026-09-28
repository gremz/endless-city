import type { Vec3 } from '../core/math';
import { Ambience } from './Ambience';
import { EngineSounds, type EngineSource } from './Engines';
import { Music } from './Music';
import { makeImpulse, renderAll } from './synth';

const MAX_VOICES = 32;

interface Voice {
  src: AudioBufferSourceNode;
  started: number;
}

export interface PlayOptions {
  /** World position (positional HRTF audio). Omit for "in your head" sounds (own gun, UI). */
  pos?: Vec3;
  volume?: number;
  rate?: number;
  /** Reverb send amount 0..1. */
  reverb?: number;
  /** 'master' skips the effects bus (not muffled by flashbang deafness). */
  bus?: 'sfx' | 'master';
  /** Distance (m) before positional falloff starts (default 3); voices carry further. */
  refDistance?: number;
  /** Through a police radio: band-limited and lightly overdriven. */
  radio?: boolean;
}

/**
 * WebAudio engine: created on the first user gesture (browsers block audio before that),
 * master bus with a compressor, a convolution reverb send, pooled voices with stealing, and an
 * HRTF listener that follows the camera.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  /** Sound effects bus (own volume, muffled when deafened by a flashbang). */
  private sfx!: GainNode;
  private sfxFilter!: BiquadFilterNode;
  private sfxVolume = 1;
  private deafen = 0;
  private reverbIn!: GainNode;
  private bank = new Map<string, AudioBuffer[]>();
  private voices: Voice[] = [];
  private ready = false;
  private volume = 0.7;
  private music: Music | null = null;
  private ambience: Ambience | null = null;
  private engines: EngineSounds | null = null;
  private paused = false;
  private musicVolume = 0.35;

  /** Create/resume the context (call from a click handler). */
  async unlock(): Promise<void> {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext({ latencyHint: 'interactive' });
      } catch {
        return;
      }
      const ctx = this.ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 10;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      comp.connect(ctx.destination);
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(comp);
      this.sfxFilter = ctx.createBiquadFilter();
      this.sfxFilter.type = 'lowpass';
      this.sfxFilter.frequency.value = 20000;
      this.sfxFilter.connect(this.master);
      this.sfx = ctx.createGain();
      this.sfx.gain.value = this.sfxVolume;
      this.sfx.connect(this.sfxFilter);
      const conv = ctx.createConvolver();
      conv.buffer = makeImpulse(ctx);
      const wet = ctx.createGain();
      wet.gain.value = 0.35;
      this.reverbIn = ctx.createGain();
      this.reverbIn.connect(conv).connect(wet).connect(this.master);
      this.music = new Music(ctx, this.master, this.reverbIn);
      // Ambience sits on the effects bus: it follows the effects volume and flashbang deafness.
      this.ambience = new Ambience(ctx, this.sfx);
      this.engines = new EngineSounds(ctx, this.sfx);
      this.music.setVolume(this.musicVolume);
      renderAll(ctx.sampleRate)
        .then((bank) => {
          // Clips loaded before synthesis finished stay in the bank.
          for (const [k, v] of this.bank) bank.set(k, v);
          this.bank = bank;
          this.ready = true;
        })
        .catch((e) => console.warn('sound synthesis failed', e));
    }
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
  }

  /**
   * Load recorded clips (the generated voice lines) into the bank under their names. Missing
   * files are skipped: the game plays on without them.
   */
  loadClips(clips: readonly { name: string; url: string }[]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const { name, url } of clips) {
      fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
        .then((data) => ctx.decodeAudioData(data))
        .then((buf) => this.bank.set(name, [buf]))
        .catch(() => {});
    }
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setSfxVolume(v: number): void {
    this.sfxVolume = v;
    this.applySfx();
  }

  /** Flashbang deafness 0..1: sound effects go dull and quiet (the ringing plays on top). */
  setDeafen(v: number): void {
    if (Math.abs(v - this.deafen) < 0.005) return;
    this.deafen = v;
    this.applySfx();
  }

  private applySfx(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.sfx.gain.setTargetAtTime(this.sfxVolume * (1 - 0.75 * this.deafen), t, 0.03);
    this.sfxFilter.frequency.setTargetAtTime(20000 * Math.pow(400 / 20000, this.deafen), t, 0.03);
  }

  setMusicVolume(v: number): void {
    this.musicVolume = v;
    this.music?.setVolume(v);
  }

  /** Combat intensity for the music's pulse layer (0 calm .. 1 fighting). */
  setMusicIntensity(v: number): void {
    this.music?.setIntensity(v);
  }

  setMusicPaused(p: boolean): void {
    this.paused = p;
    this.music?.setPaused(p);
    this.ambience?.setPaused(p);
  }

  /** Rain bed, night wind and crickets. Call every frame. */
  setAmbience(rain: number, night: number, indoor: boolean): void {
    this.ambience?.set(rain, night, indoor);
    this.ambience?.update();
  }

  /** Running car engines near the listener, nearest first. Call every frame. */
  setEngines(sources: readonly EngineSource[]): void {
    if (this.ctx?.state === 'running') this.engines?.update(sources, this.paused);
  }

  /** Schedule upcoming music; call every frame. */
  updateMusic(): void {
    this.music?.update();
  }

  /** Update the listener from the camera (position + forward/up vectors). */
  setListener(px: number, py: number, pz: number, fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    if (l.positionX) {
      const t = ctx.currentTime;
      l.positionX.setValueAtTime(px, t);
      l.positionY.setValueAtTime(py, t);
      l.positionZ.setValueAtTime(pz, t);
      l.forwardX.setValueAtTime(fx, t);
      l.forwardY.setValueAtTime(fy, t);
      l.forwardZ.setValueAtTime(fz, t);
      l.upX.setValueAtTime(ux, t);
      l.upY.setValueAtTime(uy, t);
      l.upZ.setValueAtTime(uz, t);
    } else {
      // Firefox and older browsers.
      (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(px, py, pz);
      (l as unknown as { setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void }).setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  play(name: string, opts: PlayOptions = {}, listener?: Vec3): void {
    const ctx = this.ctx;
    if (!ctx || !this.ready || ctx.state !== 'running') return;
    const list = this.bank.get(name);
    if (!list || !list.length) return;
    const buf = list[Math.floor(Math.random() * list.length)];
    // Voice limit: steal the oldest.
    if (this.voices.length >= MAX_VOICES) {
      const v = this.voices.shift()!;
      try {
        v.src.stop();
      } catch {
        // already stopped
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (opts.rate ?? 1) * (0.97 + Math.random() * 0.06);
    const g = ctx.createGain();
    g.gain.value = opts.volume ?? 1;
    let tail: AudioNode = g;
    src.connect(g);
    if (opts.radio) {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 380;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2900;
      const drive = ctx.createWaveShaper();
      drive.curve = this.radioCurve();
      tail.connect(hp).connect(drive).connect(lp);
      tail = lp;
    }
    if (opts.pos) {
      // Distance filtering: far sounds lose their highs.
      if (listener) {
        const d = Math.hypot(opts.pos.x - listener.x, opts.pos.y - listener.y, opts.pos.z - listener.z);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = Math.max(900, 18000 - d * 260);
        tail.connect(lp);
        tail = lp;
      }
      const pan = ctx.createPanner();
      pan.panningModel = 'HRTF';
      pan.distanceModel = 'inverse';
      pan.refDistance = opts.refDistance ?? 3;
      pan.rolloffFactor = 1.1;
      pan.maxDistance = 200;
      pan.positionX.value = opts.pos.x;
      pan.positionY.value = opts.pos.y;
      pan.positionZ.value = opts.pos.z;
      tail.connect(pan);
      tail = pan;
    }
    tail.connect(opts.bus === 'master' ? this.master : this.sfx);
    const rev = opts.reverb ?? 0.25;
    if (rev > 0) {
      const send = ctx.createGain();
      send.gain.value = rev;
      tail.connect(send).connect(this.reverbIn);
    }
    const voice = { src, started: ctx.currentTime };
    this.voices.push(voice);
    src.onended = () => {
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
    };
    src.start();
  }

  private radioCurveCache: Float32Array<ArrayBuffer> | null = null;

  /** Soft clipping for the radio's crunch. */
  private radioCurve(): Float32Array<ArrayBuffer> {
    if (!this.radioCurveCache) {
      const n = 1024;
      const c = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        c[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
      }
      this.radioCurveCache = c;
    }
    return this.radioCurveCache;
  }

  dispose(): void {
    this.music?.dispose();
    this.music = null;
    this.ambience?.dispose();
    this.ambience = null;
    this.engines?.dispose();
    this.engines = null;
    void this.ctx?.close();
    this.ctx = null;
  }
}
