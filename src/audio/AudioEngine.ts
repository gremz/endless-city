import type { Vec3 } from '../core/math';
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
}

/**
 * WebAudio engine: created on the first user gesture (browsers block audio before that),
 * master bus with a compressor, a convolution reverb send, pooled voices with stealing, and an
 * HRTF listener that follows the camera.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private reverbIn!: GainNode;
  private bank = new Map<string, AudioBuffer[]>();
  private voices: Voice[] = [];
  private ready = false;
  private volume = 0.7;

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
      const conv = ctx.createConvolver();
      conv.buffer = makeImpulse(ctx);
      const wet = ctx.createGain();
      wet.gain.value = 0.35;
      this.reverbIn = ctx.createGain();
      this.reverbIn.connect(conv).connect(wet).connect(this.master);
      renderAll(ctx.sampleRate)
        .then((bank) => {
          this.bank = bank;
          this.ready = true;
        })
        .catch((e) => console.warn('sound synthesis failed', e));
    }
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
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
      pan.refDistance = 3;
      pan.rolloffFactor = 1.1;
      pan.maxDistance = 200;
      pan.positionX.value = opts.pos.x;
      pan.positionY.value = opts.pos.y;
      pan.positionZ.value = opts.pos.z;
      tail.connect(pan);
      tail = pan;
    }
    tail.connect(this.master);
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

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}
