/**
 * Offline sound synthesis: every sound is rendered once at startup into an AudioBuffer from a
 * small recipe (filtered noise bursts, pitch-swept thumps, clicks, tones). No audio assets.
 */

type Build = (ctx: OfflineAudioContext, out: AudioNode, seed: number) => void;

interface Recipe {
  duration: number;
  build: Build;
  variants?: number;
}

function noiseBuffer(ctx: BaseAudioContext, seconds: number, seed: number): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  let s = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < len; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    d[i] = ((s >>> 0) / 4294967296) * 2 - 1;
  }
  return b;
}

/** Filtered noise burst with an exponential decay. */
function noise(
  ctx: OfflineAudioContext,
  out: AudioNode,
  seed: number,
  opts: { at?: number; dur: number; gain: number; type: BiquadFilterType; freq: number; q?: number; attack?: number; decay: number; freqEnd?: number },
): void {
  const at = opts.at ?? 0;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, opts.dur + 0.05, seed);
  const f = ctx.createBiquadFilter();
  f.type = opts.type;
  f.frequency.setValueAtTime(opts.freq, at);
  if (opts.freqEnd) f.frequency.exponentialRampToValueAtTime(opts.freqEnd, at + opts.dur);
  f.Q.value = opts.q ?? 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(opts.gain, at + (opts.attack ?? 0.001));
  g.gain.setTargetAtTime(0, at + (opts.attack ?? 0.001), opts.decay);
  src.connect(f).connect(g).connect(out);
  src.start(at);
  src.stop(at + opts.dur + 0.05);
}

/** Sine/triangle tone with a pitch sweep and decay (thumps, pings, chimes). */
function tone(
  ctx: OfflineAudioContext,
  out: AudioNode,
  opts: { at?: number; f0: number; f1?: number; sweep?: number; gain: number; decay: number; dur: number; type?: OscillatorType },
): void {
  const at = opts.at ?? 0;
  const o = ctx.createOscillator();
  o.type = opts.type ?? 'sine';
  o.frequency.setValueAtTime(opts.f0, at);
  if (opts.f1) o.frequency.exponentialRampToValueAtTime(opts.f1, at + (opts.sweep ?? 0.08));
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(opts.gain, at + 0.002);
  g.gain.setTargetAtTime(0, at + 0.002, opts.decay);
  o.connect(g).connect(out);
  o.start(at);
  o.stop(at + opts.dur);
}

/** Gunshot: sharp click + band-limited crack + low thump + long tail. */
function gun(p: { crack: number; crackQ: number; thump: number; body: number; tail: number; tailFreq: number; gain: number }): Build {
  return (ctx, out, seed) => {
    const detune = 1 + ((seed % 7) - 3) * 0.012;
    noise(ctx, out, seed * 3 + 1, { dur: 0.004, gain: 0.9 * p.gain, type: 'highpass', freq: 3000, decay: 0.001 });
    noise(ctx, out, seed * 3 + 2, { dur: 0.25, gain: 1.0 * p.gain, type: 'bandpass', freq: p.crack * detune, q: p.crackQ, decay: p.body, freqEnd: p.crack * 0.5 });
    tone(ctx, out, { f0: p.thump * 2.2 * detune, f1: p.thump * detune, sweep: 0.06, gain: 0.9 * p.gain, decay: 0.05, dur: 0.3 });
    noise(ctx, out, seed * 3 + 3, { at: 0.01, dur: p.tail * 3, gain: 0.35 * p.gain, type: 'lowpass', freq: p.tailFreq, decay: p.tail, freqEnd: p.tailFreq * 0.4 });
  };
}

export const RECIPES: Record<string, Recipe> = {
  pistol: { duration: 0.9, variants: 3, build: gun({ crack: 2400, crackQ: 0.9, thump: 140, body: 0.03, tail: 0.18, tailFreq: 1800, gain: 0.7 }) },
  deagle: { duration: 1.3, variants: 3, build: gun({ crack: 1500, crackQ: 0.7, thump: 90, body: 0.05, tail: 0.3, tailFreq: 1400, gain: 1 }) },
  smg: { duration: 0.8, variants: 3, build: gun({ crack: 2800, crackQ: 1.1, thump: 150, body: 0.025, tail: 0.14, tailFreq: 2200, gain: 0.65 }) },
  rifle_heavy: { duration: 1.2, variants: 3, build: gun({ crack: 1700, crackQ: 0.8, thump: 95, body: 0.045, tail: 0.26, tailFreq: 1500, gain: 0.95 }) },
  rifle_light: { duration: 1.1, variants: 3, build: gun({ crack: 2100, crackQ: 1.0, thump: 115, body: 0.035, tail: 0.22, tailFreq: 1900, gain: 0.85 }) },
  awp: { duration: 1.8, variants: 2, build: gun({ crack: 1100, crackQ: 0.6, thump: 65, body: 0.08, tail: 0.5, tailFreq: 1100, gain: 1.2 }) },
  knife: {
    duration: 0.3,
    variants: 2,
    build: (ctx, out, s) => noise(ctx, out, s, { dur: 0.18, gain: 0.35, type: 'bandpass', freq: 2500, q: 2, attack: 0.05, decay: 0.05, freqEnd: 900 }),
  },
  step: {
    duration: 0.25,
    variants: 4,
    build: (ctx, out, s) => {
      noise(ctx, out, s, { dur: 0.08, gain: 0.5, type: 'bandpass', freq: 700 + (s % 4) * 90, q: 1.2, decay: 0.025 });
      tone(ctx, out, { f0: 110 + (s % 3) * 12, f1: 60, sweep: 0.05, gain: 0.35, decay: 0.03, dur: 0.15 });
      noise(ctx, out, s + 9, { at: 0.02, dur: 0.05, gain: 0.15, type: 'highpass', freq: 3000, decay: 0.01 });
    },
  },
  land: {
    duration: 0.4,
    build: (ctx, out, s) => {
      noise(ctx, out, s, { dur: 0.15, gain: 0.6, type: 'lowpass', freq: 900, decay: 0.05 });
      tone(ctx, out, { f0: 90, f1: 45, sweep: 0.1, gain: 0.6, decay: 0.06, dur: 0.3 });
    },
  },
  reload: {
    duration: 1.6,
    build: (ctx, out, s) => {
      for (const [at, f] of [
        [0.05, 1800],
        [0.12, 900],
        [0.9, 2200],
        [0.97, 1100],
        [1.3, 2600],
        [1.36, 1300],
      ] as const) {
        noise(ctx, out, s + at * 100, { at, dur: 0.03, gain: 0.45, type: 'bandpass', freq: f, q: 3, decay: 0.012 });
      }
    },
  },
  deploy: {
    duration: 0.5,
    build: (ctx, out, s) => {
      noise(ctx, out, s, { at: 0.02, dur: 0.03, gain: 0.35, type: 'bandpass', freq: 1600, q: 3, decay: 0.01 });
      noise(ctx, out, s + 1, { at: 0.18, dur: 0.03, gain: 0.4, type: 'bandpass', freq: 2400, q: 3, decay: 0.01 });
    },
  },
  dryfire: {
    duration: 0.15,
    build: (ctx, out, s) => noise(ctx, out, s, { dur: 0.02, gain: 0.5, type: 'bandpass', freq: 3200, q: 4, decay: 0.008 }),
  },
  hit: {
    duration: 0.25,
    build: (ctx, out, s) => {
      tone(ctx, out, { f0: 180, f1: 90, sweep: 0.08, gain: 0.5, decay: 0.05, dur: 0.2 });
      noise(ctx, out, s, { dur: 0.06, gain: 0.25, type: 'lowpass', freq: 1200, decay: 0.02 });
    },
  },
  headshot: {
    duration: 0.8,
    build: (ctx, out) => {
      // Helmet "tink": inharmonic metallic partials.
      for (const [f, g] of [
        [2900, 0.3],
        [4350, 0.2],
        [6120, 0.12],
      ] as const) {
        tone(ctx, out, { f0: f, gain: g, decay: 0.12, dur: 0.7 });
      }
    },
  },
  hurt: {
    duration: 0.35,
    build: (ctx, out, s) => {
      tone(ctx, out, { f0: 120, f1: 55, sweep: 0.12, gain: 0.7, decay: 0.08, dur: 0.3 });
      noise(ctx, out, s, { dur: 0.1, gain: 0.3, type: 'lowpass', freq: 600, decay: 0.04 });
    },
  },
  impact: {
    duration: 0.3,
    variants: 3,
    build: (ctx, out, s) => noise(ctx, out, s, { dur: 0.1, gain: 0.35, type: 'bandpass', freq: 1400 + (s % 3) * 500, q: 1.5, decay: 0.03 }),
  },
  ricochet: {
    duration: 0.5,
    variants: 2,
    build: (ctx, out) => tone(ctx, out, { f0: 3800, f1: 1800, sweep: 0.3, gain: 0.18, decay: 0.12, dur: 0.45, type: 'triangle' }),
  },
  buy: {
    duration: 0.5,
    build: (ctx, out) => {
      tone(ctx, out, { f0: 880, gain: 0.25, decay: 0.08, dur: 0.3 });
      tone(ctx, out, { at: 0.08, f0: 1320, gain: 0.25, decay: 0.1, dur: 0.35 });
    },
  },
  deny: {
    duration: 0.3,
    build: (ctx, out) => tone(ctx, out, { f0: 220, gain: 0.25, decay: 0.08, dur: 0.25, type: 'square' }),
  },
  cleared: {
    duration: 1.4,
    build: (ctx, out) => {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(ctx, out, { at: i * 0.11, f0: f, gain: 0.22, decay: 0.25, dur: 1.2, type: 'triangle' }));
    },
  },
  objective: {
    duration: 1.2,
    build: (ctx, out) => {
      tone(ctx, out, { f0: 783.99, gain: 0.16, decay: 0.3, dur: 0.9, type: 'triangle' });
      tone(ctx, out, { at: 0.14, f0: 1174.66, gain: 0.16, decay: 0.4, dur: 1, type: 'triangle' });
    },
  },
  pickup: {
    duration: 0.5,
    build: (ctx, out) => {
      tone(ctx, out, { f0: 660, gain: 0.22, decay: 0.05, dur: 0.2, type: 'triangle' });
      tone(ctx, out, { at: 0.07, f0: 990, gain: 0.22, decay: 0.12, dur: 0.4, type: 'triangle' });
    },
  },
  heal: {
    duration: 1.2,
    build: (ctx, out, s) => {
      // Bandage rustle, then a soft rising chime.
      noise(ctx, out, s, { dur: 0.35, gain: 0.18, type: 'bandpass', freq: 3000, q: 0.8, attack: 0.08, decay: 0.12, freqEnd: 1800 });
      tone(ctx, out, { at: 0.05, f0: 440, f1: 880, sweep: 0.5, gain: 0.14, decay: 0.3, dur: 1.1 });
      tone(ctx, out, { at: 0.2, f0: 1320, gain: 0.08, decay: 0.3, dur: 1 });
    },
  },
  kill: {
    duration: 0.3,
    build: (ctx, out) => tone(ctx, out, { f0: 1200, f1: 700, sweep: 0.12, gain: 0.18, decay: 0.06, dur: 0.25, type: 'triangle' }),
  },
  pin_pull: {
    duration: 0.3,
    build: (ctx, out, s) => {
      noise(ctx, out, s, { dur: 0.03, gain: 0.4, type: 'bandpass', freq: 3800, q: 5, decay: 0.01 });
      tone(ctx, out, { at: 0.06, f0: 5200, gain: 0.08, decay: 0.05, dur: 0.2, type: 'triangle' });
      noise(ctx, out, s + 1, { at: 0.12, dur: 0.02, gain: 0.3, type: 'bandpass', freq: 2600, q: 4, decay: 0.008 });
    },
  },
  nade_throw: {
    duration: 0.4,
    build: (ctx, out, s) => noise(ctx, out, s, { dur: 0.25, gain: 0.3, type: 'bandpass', freq: 700, q: 0.9, attack: 0.08, decay: 0.07, freqEnd: 1600 }),
  },
  nade_bounce: {
    duration: 0.3,
    variants: 3,
    build: (ctx, out, s) => {
      noise(ctx, out, s, { dur: 0.03, gain: 0.5, type: 'bandpass', freq: 1300 + (s % 3) * 300, q: 3, decay: 0.012 });
      tone(ctx, out, { f0: 520 + (s % 3) * 80, gain: 0.15, decay: 0.03, dur: 0.12, type: 'triangle' });
    },
  },
  he_explode: {
    duration: 3,
    variants: 2,
    build: (ctx, out, s) => {
      noise(ctx, out, s, { dur: 0.02, gain: 1, type: 'highpass', freq: 1500, decay: 0.006 });
      noise(ctx, out, s + 1, { dur: 0.6, gain: 1.2, type: 'lowpass', freq: 2400, decay: 0.12, freqEnd: 300 });
      tone(ctx, out, { f0: 110, f1: 32, sweep: 0.35, gain: 1.3, decay: 0.28, dur: 1.2 });
      noise(ctx, out, s + 2, { at: 0.05, dur: 2.6, gain: 0.45, type: 'lowpass', freq: 700, decay: 0.7, freqEnd: 120 });
      // Debris settling.
      for (let i = 0; i < 6; i++) {
        noise(ctx, out, s + 10 + i, { at: 0.35 + i * 0.13 + (s % 5) * 0.02, dur: 0.02, gain: 0.12, type: 'bandpass', freq: 2500 + i * 300, q: 3, decay: 0.01 });
      }
    },
  },
  flash_bang: {
    duration: 1.6,
    build: (ctx, out, s) => {
      noise(ctx, out, s, { dur: 0.015, gain: 1, type: 'highpass', freq: 2500, decay: 0.004 });
      noise(ctx, out, s + 1, { dur: 0.3, gain: 1, type: 'bandpass', freq: 1800, q: 0.6, decay: 0.06, freqEnd: 600 });
      tone(ctx, out, { f0: 160, f1: 60, sweep: 0.12, gain: 0.8, decay: 0.1, dur: 0.5 });
      noise(ctx, out, s + 2, { at: 0.02, dur: 1.3, gain: 0.25, type: 'lowpass', freq: 1200, decay: 0.35, freqEnd: 200 });
    },
  },
  flash_ring: {
    duration: 4,
    build: (ctx, out) => {
      tone(ctx, out, { f0: 3520, gain: 0.25, decay: 1.4, dur: 4 });
      tone(ctx, out, { f0: 3544, gain: 0.12, decay: 1.2, dur: 4 });
    },
  },
  smoke_pop: {
    duration: 3,
    build: (ctx, out, s) => {
      noise(ctx, out, s, { dur: 0.03, gain: 0.5, type: 'bandpass', freq: 1200, q: 2, decay: 0.01 });
      noise(ctx, out, s + 1, { at: 0.03, dur: 2.8, gain: 0.35, type: 'highpass', freq: 2600, attack: 0.15, decay: 0.9, freqEnd: 1500 });
      noise(ctx, out, s + 2, { at: 0.03, dur: 2.2, gain: 0.25, type: 'bandpass', freq: 600, q: 0.7, attack: 0.1, decay: 0.6 });
    },
  },
  molotov_break: {
    duration: 1.4,
    build: (ctx, out, s) => {
      noise(ctx, out, s, { dur: 0.08, gain: 0.7, type: 'highpass', freq: 3500, decay: 0.03 });
      for (let i = 0; i < 5; i++) {
        tone(ctx, out, { at: 0.01 + i * 0.03, f0: 2800 + ((s + i * 7) % 9) * 350, gain: 0.08, decay: 0.05, dur: 0.2, type: 'triangle' });
      }
      noise(ctx, out, s + 1, { at: 0.05, dur: 1.2, gain: 0.6, type: 'lowpass', freq: 500, attack: 0.1, decay: 0.35, freqEnd: 1400 });
    },
  },
  fire: {
    duration: 1.2,
    variants: 3,
    build: (ctx, out, s) => {
      noise(ctx, out, s, { dur: 1.1, gain: 0.35, type: 'lowpass', freq: 600, attack: 0.25, decay: 0.5 });
      for (let i = 0; i < 7; i++) {
        noise(ctx, out, s * 13 + i, { at: ((s * 7 + i * 37) % 100) / 100, dur: 0.02, gain: 0.25, type: 'bandpass', freq: 1800 + ((i * 53) % 7) * 250, q: 4, decay: 0.006 });
      }
    },
  },
  thunder: {
    duration: 5,
    variants: 3,
    build: (ctx, out, s) => {
      // A sharp crack for close strikes, then a long rolling rumble.
      noise(ctx, out, s, { dur: 0.25, gain: 0.5 + (s % 3) * 0.2, type: 'bandpass', freq: 1400, q: 0.6, decay: 0.08, freqEnd: 300 });
      for (let i = 0; i < 4; i++) {
        noise(ctx, out, s * 7 + i, { at: 0.1 + i * 0.5 + (s % 2) * 0.2, dur: 2.2, gain: 0.7 - i * 0.12, type: 'lowpass', freq: 260, attack: 0.25, decay: 0.6, freqEnd: 80 });
      }
      tone(ctx, out, { at: 0.05, f0: 60, f1: 30, sweep: 1.5, gain: 0.5, decay: 0.9, dur: 3.5 });
    },
  },
  step_wet: {
    duration: 0.3,
    variants: 4,
    build: (ctx, out, s) => {
      noise(ctx, out, s, { dur: 0.1, gain: 0.45, type: 'bandpass', freq: 900 + (s % 4) * 110, q: 1, decay: 0.03 });
      noise(ctx, out, s + 5, { at: 0.01, dur: 0.12, gain: 0.3, type: 'highpass', freq: 3500, attack: 0.01, decay: 0.04 });
      tone(ctx, out, { f0: 100 + (s % 3) * 10, f1: 55, sweep: 0.05, gain: 0.25, decay: 0.03, dur: 0.15 });
    },
  },
  flashlight: {
    duration: 0.15,
    build: (ctx, out, s) => noise(ctx, out, s, { dur: 0.02, gain: 0.35, type: 'bandpass', freq: 2800, q: 5, decay: 0.006 }),
  },
  car_door: {
    duration: 0.5,
    variants: 2,
    build: (ctx, out, s) => {
      // Latch click, then the door's dull thunk.
      noise(ctx, out, s, { dur: 0.015, gain: 0.35, type: 'bandpass', freq: 3200, q: 2, decay: 0.004 });
      tone(ctx, out, { at: 0.01, f0: 150 + (s % 2) * 20, f1: 70, sweep: 0.06, gain: 0.8, decay: 0.05, dur: 0.3 });
      noise(ctx, out, s + 3, { at: 0.01, dur: 0.12, gain: 0.4, type: 'lowpass', freq: 800, decay: 0.03 });
    },
  },
  car_crash: {
    duration: 1.4,
    variants: 3,
    build: (ctx, out, s) => {
      tone(ctx, out, { f0: 120, f1: 40, sweep: 0.12, gain: 1.1, decay: 0.09, dur: 0.6 });
      noise(ctx, out, s, { dur: 0.35, gain: 0.9, type: 'bandpass', freq: 1300, q: 0.7, decay: 0.08, freqEnd: 500 });
      // Crumpling metal and bits of glass.
      for (let i = 0; i < 5; i++) {
        noise(ctx, out, s * 5 + i, { at: 0.03 + i * 0.05 + (s % 3) * 0.01, dur: 0.05, gain: 0.25, type: 'bandpass', freq: 2200 + i * 700, q: 4, decay: 0.02 });
      }
      noise(ctx, out, s + 20, { at: 0.08, dur: 0.6, gain: 0.15, type: 'highpass', freq: 4000, decay: 0.12 });
    },
  },
  door_open: {
    duration: 0.9,
    variants: 2,
    build: (ctx, out, s) => {
      // Latch, then a creaking hinge.
      noise(ctx, out, s, { dur: 0.02, gain: 0.35, type: 'bandpass', freq: 2600, q: 3, decay: 0.006 });
      tone(ctx, out, { at: 0.05, f0: 420 + (s % 2) * 60, f1: 300, sweep: 0.5, gain: 0.08, decay: 0.25, dur: 0.6, type: 'sawtooth' });
      noise(ctx, out, s + 2, { at: 0.05, dur: 0.5, gain: 0.12, type: 'bandpass', freq: 900, q: 6, attack: 0.1, decay: 0.2 });
    },
  },
  door_close: {
    duration: 0.5,
    build: (ctx, out, s) => {
      tone(ctx, out, { f0: 130, f1: 70, sweep: 0.06, gain: 0.7, decay: 0.05, dur: 0.3 });
      noise(ctx, out, s, { dur: 0.1, gain: 0.45, type: 'lowpass', freq: 900, decay: 0.03 });
      noise(ctx, out, s + 1, { at: 0.01, dur: 0.02, gain: 0.3, type: 'bandpass', freq: 3000, q: 3, decay: 0.006 });
    },
  },
  door_kick: {
    duration: 0.8,
    variants: 2,
    build: (ctx, out, s) => {
      tone(ctx, out, { f0: 110, f1: 45, sweep: 0.08, gain: 1.1, decay: 0.07, dur: 0.4 });
      noise(ctx, out, s, { dur: 0.25, gain: 0.8, type: 'bandpass', freq: 700, q: 0.8, decay: 0.06 });
      noise(ctx, out, s + 4, { at: 0.02, dur: 0.2, gain: 0.3, type: 'bandpass', freq: 2200, q: 2, decay: 0.05 });
    },
  },
  door_break: {
    duration: 1.2,
    build: (ctx, out, s) => {
      tone(ctx, out, { f0: 95, f1: 40, sweep: 0.1, gain: 1.1, decay: 0.08, dur: 0.5 });
      // Splintering wood.
      for (let i = 0; i < 8; i++) {
        noise(ctx, out, s * 11 + i, { at: 0.01 + i * 0.035, dur: 0.05, gain: 0.35, type: 'bandpass', freq: 900 + ((i * 37) % 5) * 400, q: 3, decay: 0.02 });
      }
      noise(ctx, out, s + 30, { at: 0.2, dur: 0.6, gain: 0.25, type: 'lowpass', freq: 600, decay: 0.2 });
    },
  },
  door_locked: {
    duration: 0.4,
    build: (ctx, out, s) => {
      for (let i = 0; i < 3; i++) noise(ctx, out, s + i, { at: i * 0.07, dur: 0.03, gain: 0.35, type: 'bandpass', freq: 2000 + i * 150, q: 4, decay: 0.01 });
    },
  },
  glass_break: {
    duration: 1.6,
    variants: 3,
    build: (ctx, out, s) => {
      noise(ctx, out, s, { dur: 0.1, gain: 0.8, type: 'highpass', freq: 3000, decay: 0.04 });
      // Shards ringing and tinkling down.
      for (let i = 0; i < 12; i++) {
        tone(ctx, out, { at: 0.01 + i * 0.045 + ((s * 7 + i * 13) % 10) / 400, f0: 3000 + ((s * 5 + i * 11) % 13) * 300, gain: 0.07, decay: 0.04, dur: 0.15, type: 'triangle' });
      }
      noise(ctx, out, s + 50, { at: 0.2, dur: 1, gain: 0.2, type: 'highpass', freq: 5000, attack: 0.05, decay: 0.35 });
    },
  },
  fire_out: {
    duration: 1,
    build: (ctx, out, s) => noise(ctx, out, s, { dur: 0.9, gain: 0.4, type: 'highpass', freq: 2000, attack: 0.02, decay: 0.3, freqEnd: 900 }),
  },
};

/** Render all recipes (and their variants) into buffers. */
export async function renderAll(sampleRate: number): Promise<Map<string, AudioBuffer[]>> {
  const out = new Map<string, AudioBuffer[]>();
  const jobs: Promise<void>[] = [];
  for (const [name, r] of Object.entries(RECIPES)) {
    const list: AudioBuffer[] = [];
    out.set(name, list);
    for (let v = 0; v < (r.variants ?? 1); v++) {
      const ctx = new OfflineAudioContext(1, Math.ceil(r.duration * sampleRate), sampleRate);
      const bus = ctx.createGain();
      bus.connect(ctx.destination);
      r.build(ctx, bus, v + 1);
      jobs.push(
        ctx.startRendering().then((buf) => {
          list[v] = buf;
        }),
      );
    }
  }
  await Promise.all(jobs);
  return out;
}

/** Synthesized room impulse response for the reverb send. */
export function makeImpulse(ctx: BaseAudioContext, seconds = 1.1, decay = 3): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let s = 1234567 + c * 7654321;
    for (let i = 0; i < len; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const n = ((s >>> 0) / 4294967296) * 2 - 1;
      d[i] = n * Math.pow(1 - i / len, decay);
    }
  }
  return b;
}
