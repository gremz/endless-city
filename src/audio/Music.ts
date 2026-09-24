/**
 * Generative ambient background music, played live through WebAudio (no assets): a slow
 * A-minor pad progression with a sparse arpeggio through a delay, plus a soft pulse layer
 * (bass, kick, ticks) that fades in with combat intensity. Notes are scheduled a little ahead
 * of the audio clock from the frame loop.
 */

const BPM = 72;
/** One step = an eighth note. */
const STEP = 60 / BPM / 2;
/** Steps per chord (two 4/4 bars). */
const CHORD_STEPS = 16;
const LOOKAHEAD = 0.3;

interface Chord {
  /** Pad voicing (MIDI notes). */
  pad: number[];
  /** Root for the pulse bass. */
  bass: number;
}

/** Am9 → Fmaj7 → Cadd9 → Gsus2. */
const PROGRESSION: Chord[] = [
  { pad: [57, 60, 64, 71], bass: 45 },
  { pad: [53, 57, 60, 64], bass: 41 },
  { pad: [55, 60, 62, 64], bass: 48 },
  { pad: [55, 57, 62, 67], bass: 43 },
];

const midiHz = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

export class Music {
  private out: GainNode;
  private padBus: GainNode;
  private arpBus: GainNode;
  private pulseBus: GainNode;
  private noise: AudioBuffer;
  private step = 0;
  private nextTime = 0;
  private started = false;
  private volume = 0.35;
  private paused = false;
  private intensity = 0;
  private lastArp = -1;
  /** Audio time until which the pulse layer keeps playing (covers its fade-out). */
  private pulseUntil = 0;

  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
    reverbSend: AudioNode,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);

    // Pad: one shared lowpass whose cutoff drifts slowly.
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 750;
    padFilter.Q.value = 0.7;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 280;
    lfo.connect(lfoDepth).connect(padFilter.frequency);
    lfo.start();
    this.padBus = ctx.createGain();
    this.padBus.connect(padFilter).connect(this.out);

    // Arp: dry plus a dotted-eighth feedback delay.
    this.arpBus = ctx.createGain();
    this.arpBus.connect(this.out);
    const delay = ctx.createDelay(2);
    delay.delayTime.value = STEP * 1.5;
    const fb = ctx.createGain();
    fb.gain.value = 0.35;
    const fbFilter = ctx.createBiquadFilter();
    fbFilter.type = 'lowpass';
    fbFilter.frequency.value = 2200;
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    this.arpBus.connect(delay);
    delay.connect(fbFilter).connect(fb).connect(delay);
    fbFilter.connect(wet).connect(this.out);

    // Both melodic layers get some room.
    const send = ctx.createGain();
    send.gain.value = 0.5;
    padFilter.connect(send);
    wet.connect(send);
    send.connect(reverbSend);

    // Combat pulse, silent until intensity rises.
    this.pulseBus = ctx.createGain();
    this.pulseBus.gain.value = 0;
    this.pulseBus.connect(this.out);

    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  setVolume(v: number): void {
    this.volume = v;
    this.applyGain(0.3);
  }

  /** Paused: duck and drop the combat layer. */
  setPaused(p: boolean): void {
    if (p === this.paused) return;
    this.paused = p;
    this.applyGain(0.6);
    this.applyIntensity();
  }

  /** 0 = calm, 1 = in a firefight. */
  setIntensity(v: number): void {
    if (v === this.intensity) return;
    this.intensity = v;
    this.applyIntensity();
  }

  private applyGain(tau: number): void {
    if (!this.started) return;
    this.out.gain.setTargetAtTime(this.volume * (this.paused ? 0.4 : 1), this.ctx.currentTime, tau);
  }

  private applyIntensity(): void {
    const target = this.paused ? 0 : this.intensity;
    // Quick to swell in, slow to settle.
    const tau = target > 0 ? 0.5 : 1.8;
    this.pulseBus.gain.setTargetAtTime(target, this.ctx.currentTime, tau);
  }

  /** Schedule upcoming notes; call every frame. */
  update(): void {
    const ctx = this.ctx;
    if (ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (!this.started) {
      this.started = true;
      this.nextTime = now + 0.1;
      this.out.gain.setValueAtTime(0, now);
      this.out.gain.setTargetAtTime(this.volume * (this.paused ? 0.4 : 1), now, 1.5);
    }
    if (this.nextTime < now - 0.05) {
      // Frames stopped (hidden tab): resume at the next chord so the pad comes straight back.
      this.nextTime = now + 0.05;
      this.step = Math.ceil(this.step / CHORD_STEPS) * CHORD_STEPS;
    }
    while (this.nextTime < now + LOOKAHEAD) {
      this.schedule(this.step, this.nextTime);
      this.step++;
      this.nextTime += STEP;
    }
  }

  private schedule(step: number, t: number): void {
    const s = step % CHORD_STEPS;
    const chord = PROGRESSION[Math.floor(step / CHORD_STEPS) % PROGRESSION.length];
    if (s === 0) this.pad(chord, t, CHORD_STEPS * STEP);
    // Arpeggio: sparse, a little busier on the beat.
    const p = s % 2 === 0 ? 0.6 : 0.4;
    if (Math.random() < p) {
      const pool = chord.pad.map((n) => n + 12);
      let n = pool[Math.floor(Math.random() * pool.length)];
      if (n === this.lastArp) n = pool[(pool.indexOf(n) + 1) % pool.length];
      this.lastArp = n;
      this.pluck(midiHz(n), t, 0.05 + Math.random() * 0.03);
    }
    // Pulse layer: scheduled while its bus is audible (including the fade-out).
    if (!this.paused && this.intensity > 0) this.pulseUntil = t + 10;
    if (t < this.pulseUntil) {
      this.bass(midiHz(chord.bass), t, s % 4 === 0 ? 0.22 : 0.14);
      if (s % 4 === 0) this.kick(t);
      if (s % 2 === 1) this.tick(t);
    }
  }

  private pad(chord: Chord, t: number, len: number): void {
    const ctx = this.ctx;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.045, t + 2.5);
    env.gain.setValueAtTime(0.045, t + len);
    env.gain.setTargetAtTime(0, t + len, 1);
    env.connect(this.padBus);
    const end = t + len + 5;
    let live = 0;
    for (const n of chord.pad) {
      for (const detune of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midiHz(n);
        o.detune.value = detune;
        o.connect(env);
        o.start(t);
        o.stop(end);
        live++;
        o.onended = () => {
          o.disconnect();
          if (--live === 0) env.disconnect();
        };
      }
    }
  }

  private pluck(hz: number, t: number, gain: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.006);
    g.gain.setTargetAtTime(0, t + 0.006, 0.22);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 0.8 - 0.4;
    o.connect(g).connect(pan).connect(this.arpBus);
    o.start(t);
    o.stop(t + 1.5);
    o.onended = () => pan.disconnect();
  }

  private bass(hz: number, t: number, gain: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = hz;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.setTargetAtTime(0, t + 0.01, 0.12);
    o.connect(f).connect(g).connect(this.pulseBus);
    o.start(t);
    o.stop(t + 0.6);
    o.onended = () => g.disconnect();
  }

  private kick(t: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.28, t + 0.004);
    g.gain.setTargetAtTime(0, t + 0.004, 0.08);
    o.connect(g).connect(this.pulseBus);
    o.start(t);
    o.stop(t + 0.5);
    o.onended = () => g.disconnect();
  }

  private tick(t: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.002);
    g.gain.setTargetAtTime(0, t + 0.002, 0.025);
    src.connect(f).connect(g).connect(this.pulseBus);
    src.start(t, Math.random() * 0.8);
    src.stop(t + 0.15);
    src.onended = () => g.disconnect();
  }

  dispose(): void {
    this.out.disconnect();
  }
}
