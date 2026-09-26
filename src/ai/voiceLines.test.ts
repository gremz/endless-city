import { describe, expect, it } from 'vitest';
import { VOICE_DURATIONS } from './voiceDurations';
import { BARK_SCRIPT, FACTION_VOICES, linesFor, VOICE_LINES, VOICES, voiceFile, type BarkCue, type Faction } from './voiceLines';

/** The clips on disk (just their names: `?url` doesn't read them). */
const CLIPS = new Set(Object.keys(import.meta.glob('/public/voice/*.mp3', { query: '?url', import: 'default' })).map((p) => p.replace('/public/', '')));

describe('voice lines', () => {
  it('every clip on disk is a line, measured (run `npm run voices -- --measure` after adding clips)', () => {
    const files = new Map(VOICE_LINES.map((l) => [voiceFile(l.id), l.id]));
    for (const clip of CLIPS) {
      const id = files.get(clip);
      expect(id, `${clip} isn't a line`).toBeDefined();
      expect(VOICE_DURATIONS[id!], id).toBeGreaterThan(0.3);
    }
    for (const id of Object.keys(VOICE_DURATIONS)) expect(CLIPS.has(voiceFile(id)), `${id} measured but has no clip`).toBe(true);
  });

  it('Piper lines are generated (`npm run voices`), and the opening scene is recorded', () => {
    for (const l of VOICE_LINES) {
      const v = VOICES[l.voice];
      if (v.source === 'piper' || l.voice === 'gunman' || l.voice === 'shover' || l.voice === 'officer') {
        expect(CLIPS.has(voiceFile(l.id)), l.id).toBe(true);
      }
    }
  });

  it('ids are unique', () => {
    expect(new Set(VOICE_LINES.map((l) => l.id)).size).toBe(VOICE_LINES.length);
  });

  it('every squad voice has something to say for every bark', () => {
    for (const faction of Object.keys(FACTION_VOICES) as Faction[]) {
      for (const voice of FACTION_VOICES[faction]) {
        for (const cue of Object.keys(BARK_SCRIPT.gang) as BarkCue[]) expect(linesFor(voice, cue).length, `${voice} ${cue}`).toBeGreaterThan(0);
      }
    }
  });
});
