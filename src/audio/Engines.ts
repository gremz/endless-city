/** A car engine heard in the world: where it is, how fast it's going and how hard it's pushed. */
export interface EngineSource {
  id: number;
  x: number;
  y: number;
  z: number;
  speed: number;
  /** 0..1 throttle (either direction). */
  load: number;
}

interface EngineVoice {
  id: number;
  low: OscillatorNode;
  high: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  pan: PannerNode;
}

const VOICES = 3;
/** Speed span of each "gear" (m/s): the note climbs through it, then drops back. */
const GEAR = 7;

/**
 * Engine hum for the nearest running cars, synthesized live: two detuned oscillators through a
 * lowpass that opens with throttle, pitched by a fake gearbox, positioned with HRTF. Voices are
 * made once and reassigned, so nothing is created per frame.
 */
export class EngineSounds {
  private voices: EngineVoice[] = [];

  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
  ) {
    for (let i = 0; i < VOICES; i++) {
      const low = ctx.createOscillator();
      low.type = 'sawtooth';
      const high = ctx.createOscillator();
      high.type = 'square';
      const mix = ctx.createGain();
      mix.gain.value = 0.5;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 2;
      filter.frequency.value = 300;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createPanner();
      pan.panningModel = 'HRTF';
      pan.distanceModel = 'inverse';
      pan.refDistance = 4;
      pan.rolloffFactor = 1.2;
      pan.maxDistance = 120;
      low.connect(filter);
      high.connect(mix).connect(filter);
      filter.connect(gain).connect(pan).connect(dest);
      low.start();
      high.start();
      this.voices.push({ id: -1, low, high, filter, gain, pan });
    }
  }

  /** Sound the given engines (nearest first; extras are silent). */
  update(sources: readonly EngineSource[], paused: boolean): void {
    const t = this.ctx.currentTime;
    const used = new Set<EngineVoice>();
    const list = paused ? [] : sources.slice(0, VOICES);
    // Keep each car on the voice it already had, so its pitch glides instead of jumping.
    const assign = new Map<EngineSource, EngineVoice>();
    for (const s of list) {
      const v = this.voices.find((x) => x.id === s.id && !used.has(x));
      if (v) {
        assign.set(s, v);
        used.add(v);
      }
    }
    for (const s of list) {
      if (assign.has(s)) continue;
      const v = this.voices.find((x) => !used.has(x))!;
      v.id = s.id;
      assign.set(s, v);
      used.add(v);
    }
    for (const [s, v] of assign) {
      const gear = Math.min(4, Math.floor(s.speed / GEAR));
      const rev = (s.speed - gear * GEAR) / GEAR;
      const f = 34 + gear * 5 + Math.min(1.2, rev) * 42 + s.load * 6;
      v.low.frequency.setTargetAtTime(f, t, 0.05);
      v.high.frequency.setTargetAtTime(f * 2.01, t, 0.05);
      v.filter.frequency.setTargetAtTime(260 + s.load * 900 + f * 3, t, 0.08);
      v.gain.gain.setTargetAtTime(0.1 + s.load * 0.12 + Math.min(0.08, s.speed * 0.004), t, 0.08);
      v.pan.positionX.setValueAtTime(s.x, t);
      v.pan.positionY.setValueAtTime(s.y, t);
      v.pan.positionZ.setValueAtTime(s.z, t);
    }
    for (const v of this.voices) {
      if (used.has(v)) continue;
      v.id = -1;
      v.gain.gain.setTargetAtTime(0, t, 0.15);
    }
  }

  dispose(): void {
    for (const v of this.voices) {
      v.low.stop();
      v.high.stop();
    }
  }
}
