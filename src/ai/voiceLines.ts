/**
 * Spoken lines, generated offline with Piper (`npm run voices`) into `public/voice/<id>.mp3`.
 * Pure data: the bots pick lines by cue, the audio engine loads the clips, the HUD captions them.
 */
import { VOICE_DURATIONS } from './voiceDurations';

/**
 * A Piper voice and how to shape it. Audition candidates with `npm run voices -- --audition`
 * and /voices.html.
 */
export interface VoiceDef {
  /** Piper voice name (downloaded on first use). */
  model: string;
  /** Speaker, for models with several (e.g. en_GB-semaine-medium: spike, obadiah, ...). */
  speaker?: string;
  /** Speaking pace: > 1 slower. */
  lengthScale: number;
  /** Pitch factor: < 1 lower, with the voice's character kept (not slowed-tape). */
  pitch: number;
  /** Vocal tract size: < 1 bigger and darker. Default 1. */
  formant?: number;
  /** Piper's variation in tone and in timing: lower is steadier (the voices' defaults are 0.667 and 0.8). */
  noiseScale?: number;
  noiseW?: number;
  /** Name shown in captions. */
  name?: string;
}

export type VoiceId = 'gunman' | 'shover' | 'officer';

export const VOICES: Record<VoiceId, VoiceDef & { name: string }> = {
  // Semaine's aggressive character for both gang members: the gunman lower and bigger.
  gunman: { model: 'en_GB-semaine-medium', speaker: 'spike', lengthScale: 1.1, noiseScale: 0.5, noiseW: 0.4, pitch: 0.85, formant: 0.92, name: 'Gunman' },
  shover: { model: 'en_GB-semaine-medium', speaker: 'spike', lengthScale: 1.1, noiseScale: 0.5, noiseW: 0.4, pitch: 1, name: 'Thug' },
  // Shaken: a touch higher and quicker, wobbling in tone and timing.
  officer: { model: 'en_US-kusal-medium', lengthScale: 1, noiseScale: 0.8, noiseW: 1, pitch: 1.06, name: 'Officer' },
};

/** When a line is said. */
export type VoiceCue = 'taunt' | 'plead' | 'warn' | 'execute' | 'after' | 'spotted' | 'thanks';

export interface VoiceLine {
  id: string;
  voice: VoiceId;
  cue: VoiceCue;
  text: string;
}

export const VOICE_LINES: readonly VoiceLine[] = [
  { id: 'shover_taunt_1', voice: 'shover', cue: 'taunt', text: "Where's your backup now, huh?" },
  { id: 'shover_taunt_2', voice: 'shover', cue: 'taunt', text: "Nobody's coming for you, pig." },
  { id: 'shover_taunt_3', voice: 'shover', cue: 'taunt', text: 'Look at him. Shaking like a leaf.' },
  { id: 'shover_taunt_4', voice: 'shover', cue: 'taunt', text: 'Eyes on the ground! Did I say you could look at me?' },
  { id: 'shover_taunt_5', voice: 'shover', cue: 'taunt', text: 'Should have stayed home tonight, officer.' },
  { id: 'officer_plead_1', voice: 'officer', cue: 'plead', text: "Please. You don't have to do this." },
  { id: 'officer_plead_2', voice: 'officer', cue: 'plead', text: "I've got a family. Just let me go." },
  { id: 'officer_plead_3', voice: 'officer', cue: 'plead', text: "They'll find you. Every last one of you." },
  { id: 'gunman_warn_1', voice: 'gunman', cue: 'warn', text: "Enough talk. Time's up, cop." },
  { id: 'gunman_execute_1', voice: 'gunman', cue: 'execute', text: 'Say goodnight.' },
  { id: 'shover_after_1', voice: 'shover', cue: 'after', text: "Ha! That's what happens. Clean it up." },
  { id: 'gunman_spotted_1', voice: 'gunman', cue: 'spotted', text: 'Kill him!' },
  { id: 'shover_spotted_1', voice: 'shover', cue: 'spotted', text: 'We got company!' },
  { id: 'officer_thanks_1', voice: 'officer', cue: 'thanks', text: 'Thank you. I thought I was dead. Take his gun, there are cars down the street.' },
];

export const VOICE_BY_ID: ReadonlyMap<string, VoiceLine> = new Map(VOICE_LINES.map((l) => [l.id, l]));

/** Published path of a line's clip (relative to the site base). */
export const voiceFile = (id: string): string => `voice/${id}.mp3`;

/** Seconds a line takes to say: the generated clip's length, or a guess for a line not generated yet. */
export function lineSeconds(l: VoiceLine): number {
  return VOICE_DURATIONS[l.id] ?? 0.6 + l.text.length * 0.07 * VOICES[l.voice].lengthScale;
}

/** The lines for `cue` in `voice`, e.g. to pick one at random. */
export function linesFor(voice: VoiceId, cue: VoiceCue): readonly VoiceLine[] {
  return VOICE_LINES.filter((l) => l.voice === voice && l.cue === cue);
}
