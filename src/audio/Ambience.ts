/**
 * Weather and night ambience, synthesized live: a looping filtered-noise rain bed (muffled
 * indoors), a slow wind bed at night and sparse cricket chirps on dry nights. Thunder is a
 * one-shot recipe played by the audio engine.
 */
export class Ambience {
  readonly out: GainNode;
  private rainGain: GainNode;
  private rainFilter: BiquadFilterNode;
  private windGain: GainNode;
  private windFilter: BiquadFilterNode;
  private nextChirp = 0;
  private rain = 0;
  private night = 0;
  private indoor = false;
  private paused = false;

  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(dest);

    // Two seconds of noise is enough to loop without an audible repeat under the filters.
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let brown = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        // Mostly white (rain hiss) with a little brown (distant rumble on roofs).
        brown = (brown + 0.02 * w) / 1.02;
        d[i] = w * 0.6 + brown * 3;
      }
    }

    const rainSrc = ctx.createBufferSource();
    rainSrc.buffer = buf;
    rainSrc.loop = true;
    this.rainFilter = ctx.createBiquadFilter();
    this.rainFilter.type = 'lowpass';
    this.rainFilter.frequency.value = 6000;
    const rainHp = ctx.createBiquadFilter();
    rainHp.type = 'highpass';
    rainHp.frequency.value = 350;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rainSrc.connect(rainHp).connect(this.rainFilter).connect(this.rainGain).connect(this.out);
    rainSrc.start();

    const windSrc = ctx.createBufferSource();
    windSrc.buffer = buf;
    windSrc.loop = true;
    windSrc.playbackRate.value = 0.5;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 400;
    this.windFilter.Q.value = 0.8;
    // Slow gusts: an LFO sweeping the band.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 180;
    lfo.connect(lfoGain).connect(this.windFilter.frequency);
    lfo.start();
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    windSrc.connect(this.windFilter).connect(this.windGain).connect(this.out);
    windSrc.start();
  }

  /** Rain amount, darkness (0..1) and whether the listener is under a roof. */
  set(rain: number, night: number, indoor: boolean): void {
    this.rain = rain;
    this.night = night;
    this.indoor = indoor;
    const t = this.ctx.currentTime;
    const on = this.paused ? 0.3 : 1;
    this.rainGain.gain.setTargetAtTime(rain * (indoor ? 0.35 : 0.55) * on, t, 0.6);
    this.rainFilter.frequency.setTargetAtTime(indoor ? 900 : 6000, t, 0.3);
    this.windGain.gain.setTargetAtTime((night * 0.12 + rain * 0.1) * on, t, 1.5);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.set(this.rain, this.night, this.indoor);
  }

  /** Crickets on dry nights; call every frame. */
  update(): void {
    const ctx = this.ctx;
    if (ctx.state !== 'running' || this.paused) return;
    const t = ctx.currentTime;
    if (t < this.nextChirp) return;
    this.nextChirp = t + 0.6 + Math.random() * 2.2;
    const level = this.night * (1 - Math.min(1, this.rain * 3)) * (this.indoor ? 0.4 : 1);
    if (level < 0.2) return;
    // A cricket: a few quick pulses of a high tone.
    const f = 4200 + Math.random() * 900;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    pan.connect(this.out);
    const pulses = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < pulses; i++) {
      const at = t + i * 0.07;
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.018 * level, at + 0.008);
      g.gain.setTargetAtTime(0, at + 0.02, 0.01);
      o.connect(g).connect(pan);
      o.start(at);
      o.stop(at + 0.08);
    }
  }

  dispose(): void {
    this.out.disconnect();
  }
}
