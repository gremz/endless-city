import { describe, expect, it } from 'vitest';
import { VOICE_DURATIONS } from './voiceDurations';
import { VOICE_LINES, voiceFile } from './voiceLines';

/** The generated clips on disk (just their names: `?url` doesn't read them). */
const CLIPS = new Set(Object.keys(import.meta.glob('/public/voice/*.mp3', { query: '?url', import: 'default' })).map((p) => p.replace('/public/', '')));

describe('voice lines', () => {
  it('every line has a generated clip and its length (run `npm run voices` after editing lines)', () => {
    for (const l of VOICE_LINES) {
      expect(CLIPS.has(voiceFile(l.id)), l.id).toBe(true);
      expect(VOICE_DURATIONS[l.id], l.id).toBeGreaterThan(0.3);
    }
    expect(new Set(VOICE_LINES.map((l) => l.id)).size).toBe(VOICE_LINES.length);
  });
});
