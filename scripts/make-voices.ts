// Spoken lines. Most are recorded by hand in ElevenLabs; lines in Piper voices are generated.
//
// `npm run voices -- --sheet [voice ...]` lists the lines still to record (id, tab, text), by voice,
// with how to design each voice. Save each clip as public/voice/<id>.mp3, then
// `npm run voices -- --measure` writes every clip's length into src/ai/voiceDurations.ts (the
// game only loads clips listed there).
//
// `npm run voices [line-id ...]` generates the Piper voices' lines (all by default).
// Needs Python with `pip install piper-tts soundfile pyworld`; set PYTHON to use a particular one.
//
// `npm run voices -- --audition [gang|officer]` instead renders candidate voices saying sample
// lines in a few deliveries into public/voice/audition/, to compare on /voices.html.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { VOICE_DURATIONS } from '../src/ai/voiceDurations';
import { isRecorded, VOICE_LINES, VOICES, type VoiceDef, type VoiceId } from '../src/ai/voiceLines';

type Job = { id: string; text: string } & Omit<VoiceDef, 'name'>;

function run(outDir: string, lines: Job[]): Record<string, number> {
  const job = { voicesDir: '.voices', outDir, lines };
  const res = spawnSync(process.env.PYTHON ?? 'python3', ['scripts/piper_render.py'], {
    input: JSON.stringify(job),
    stdio: ['pipe', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 1 << 24,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) process.exit(res.status ?? 1);
  return JSON.parse(res.stdout) as Record<string, number>;
}

/** A set of candidate voices to compare, each saying some sample lines in a few deliveries. */
interface Audition {
  /** Which part a chosen voice goes to (a key of VOICES). */
  use: VoiceId;
  /** Sample lines: column label and text, and the part each one is for (defaults to `use`). */
  samples: { label: string; text: string; use?: VoiceId }[];
  /** Label, Piper model, speaker (for multi-speaker models). */
  voices: [label: string, model: string, speaker?: string][];
  treatments: Record<string, Partial<VoiceDef>>;
}

const AUDITIONS: Record<string, Audition> = {
  gang: {
    use: 'gunman',
    samples: [
      { label: 'gunman', text: "Enough talk. Time's up, cop." },
      { label: 'thug', text: "Where's your backup now, huh?", use: 'shover' },
    ],
    voices: [
      ['semaine-spike', 'en_GB-semaine-medium', 'spike'],
      ['semaine-obadiah', 'en_GB-semaine-medium', 'obadiah'],
      ['ryan-high', 'en_US-ryan-high'],
      ['norman', 'en_US-norman-medium'],
      ['bryce', 'en_US-bryce-medium'],
      ['hfc-male', 'en_US-hfc_male-medium'],
      ['joe', 'en_US-joe-medium'],
      ['mike', 'en_US-mike-medium'],
      ['sam', 'en_US-sam-medium'],
      ['kusal', 'en_US-kusal-medium'],
      ['alan', 'en_GB-alan-medium'],
      ['northern-english', 'en_GB-northern_english_male-medium'],
    ],
    // Steady delivery, as is and deepened (lower pitch, bigger vocal tract).
    treatments: {
      plain: { lengthScale: 1.1, noiseScale: 0.5, noiseW: 0.4 },
      deep: { lengthScale: 1.1, noiseScale: 0.5, noiseW: 0.4, pitch: 0.85, formant: 0.92 },
    },
  },
  officer: {
    use: 'officer',
    samples: [
      { label: 'plead', text: "Please. You don't have to do this. I've got a family." },
      { label: 'thanks', text: 'Thank you. I thought I was dead.' },
    ],
    voices: [
      ['john', 'en_US-john-medium'],
      ['ryan-high', 'en_US-ryan-high'],
      ['joe', 'en_US-joe-medium'],
      ['bryce', 'en_US-bryce-medium'],
      ['kusal', 'en_US-kusal-medium'],
      ['sam', 'en_US-sam-medium'],
      ['mike', 'en_US-mike-medium'],
      ['hfc-male', 'en_US-hfc_male-medium'],
      ['norman', 'en_US-norman-medium'],
      ['arctic-rms', 'en_US-arctic-medium', 'rms'],
      ['arctic-bdl', 'en_US-arctic-medium', 'bdl'],
      ['arctic-jmk', 'en_US-arctic-medium', 'jmk'],
      ['semaine-obadiah', 'en_GB-semaine-medium', 'obadiah'],
    ],
    // Steady, and shaken: a touch higher and quicker, with more wobble in tone and timing.
    treatments: {
      steady: { lengthScale: 1.05, noiseScale: 0.5, noiseW: 0.4 },
      shaken: { lengthScale: 1, noiseScale: 0.8, noiseW: 1, pitch: 1.06 },
    },
  },
};

interface AuditionClip {
  group: string;
  voice: string;
  treatment: string;
  sample: string;
  use: VoiceId;
  file: string;
  def: Omit<VoiceDef, 'name'>;
}

const MANIFEST = 'public/voice/audition/manifest.json';

/** Render the named auditions (all by default), keeping the other groups already rendered. */
function audition(groups: string[]): void {
  const names = groups.length ? groups : Object.keys(AUDITIONS);
  for (const g of names) {
    if (!AUDITIONS[g]) {
      console.error(`no audition "${g}" (there are: ${Object.keys(AUDITIONS).join(', ')})`);
      process.exit(1);
    }
  }
  let manifest: AuditionClip[] = [];
  try {
    manifest = (JSON.parse(readFileSync(MANIFEST, 'utf8')) as AuditionClip[]).filter((c) => c.group && !names.includes(c.group));
  } catch {
    // none yet (or from an older version of this script)
  }
  const jobs: Job[] = [];
  for (const group of names) {
    const a = AUDITIONS[group];
    for (const [label, model, speaker] of a.voices) {
      for (const [treatment, t] of Object.entries(a.treatments)) {
        const def = { model, ...(speaker ? { speaker } : {}), lengthScale: 1, pitch: 1, ...t };
        for (const sample of a.samples) {
          const id = `${group}_${label}_${treatment}_${sample.label}`;
          jobs.push({ id, text: sample.text, ...def });
          manifest.push({ group, voice: label, treatment, sample: sample.label, use: sample.use ?? a.use, file: `voice/audition/${id}.mp3`, def });
        }
      }
    }
  }
  run('public/voice/audition', jobs);
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  console.log(`wrote ${jobs.length} audition clips (${names.join(', ')}): open /voices.html on the dev server`);
}

function generate(only: Set<string>): void {
  const lines: Job[] = [];
  for (const l of VOICE_LINES) {
    const v = VOICES[l.voice];
    if (v.source !== 'piper' || (only.size && !only.has(l.id))) continue;
    const { name: _name, source: _source, ...def } = v;
    lines.push({ id: l.id, text: l.text, ...def });
  }
  if (!lines.length) {
    console.error(only.size ? `no such Piper line: ${[...only].join(', ')}` : 'no lines in Piper voices (record the rest: --sheet)');
    process.exit(1);
  }
  const durations = run('public/voice', lines);
  // Keep the lengths of lines not regenerated this time.
  writeDurations({ ...VOICE_DURATIONS, ...durations });
  console.log(`wrote ${lines.length} clip(s) and src/ai/voiceDurations.ts`);
}

/** Write the clip lengths, dropping lines that no longer exist. */
function writeDurations(all: Record<string, number>): void {
  const ids = new Set(VOICE_LINES.map((l) => l.id));
  const rows = Object.entries(all)
    .filter(([id]) => ids.has(id))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, s]) => `  ${id}: ${s},`);
  writeFileSync(
    'src/ai/voiceDurations.ts',
    `// Generated by \`npm run voices\`: seconds each voice clip runs.\nexport const VOICE_DURATIONS: Readonly<Record<string, number>> = {\n${rows.join('\n')}\n};\n`,
  );
}

// MPEG audio layer III: kbit/s by bitrate index, Hz by sample rate index (MPEG-1; halved for
// MPEG-2, quartered for 2.5).
const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES = [44100, 48000, 32000];

/** Seconds an MP3 runs, by walking its frame headers (no ffprobe needed). */
function mp3Seconds(buf: Uint8Array): number {
  let i = 0;
  // ID3v2 tag: 10-byte header, then a syncsafe size.
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    i = 10 + ((buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9]) + (buf[5] & 0x10 ? 10 : 0);
  }
  let samples = 0;
  let rate = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) {
      i++;
      continue;
    }
    const version = (buf[i + 1] >> 3) & 3; // 3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5
    const layer = (buf[i + 1] >> 1) & 3; // 1: layer III
    const br = buf[i + 2] >> 4;
    const sr = (buf[i + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || br === 0 || br === 15 || sr === 3) {
      i++;
      continue;
    }
    const v1 = version === 3;
    rate = RATES[sr] / (v1 ? 1 : version === 2 ? 2 : 4);
    const kbps = (v1 ? BITRATES_V1 : BITRATES_V2)[br];
    const pad = (buf[i + 2] >> 1) & 1;
    samples += v1 ? 1152 : 576;
    i += Math.floor(((v1 ? 144 : 72) * kbps * 1000) / rate) + pad;
  }
  return rate ? samples / rate : 0;
}

/** Measure every clip in public/voice and rewrite src/ai/voiceDurations.ts. */
function measure(): void {
  const all: Record<string, number> = {};
  const lines = new Set(VOICE_LINES.map((l) => l.id));
  const stray: string[] = [];
  for (const f of readdirSync('public/voice')) {
    if (!f.endsWith('.mp3')) continue;
    const id = f.slice(0, -4);
    if (!lines.has(id)) {
      stray.push(f);
      continue;
    }
    all[id] = Math.round(mp3Seconds(readFileSync(`public/voice/${f}`)) * 100) / 100;
  }
  writeDurations(all);
  console.log(`measured ${Object.keys(all).length} clip(s) into src/ai/voiceDurations.ts`);
  if (stray.length) console.warn(`not a line (ignored): ${stray.join(', ')}`);
}

/** The lines still to record, by voice: `id<TAB>text`. */
function sheet(voices: string[]): void {
  for (const [voice, v] of Object.entries(VOICES) as [VoiceId, (typeof VOICES)[VoiceId]][]) {
    if (v.source !== 'elevenlabs' || (voices.length && !voices.includes(voice))) continue;
    const todo = VOICE_LINES.filter((l) => l.voice === voice && !isRecorded(l));
    if (!todo.length) continue;
    console.log(`\n# ${voice} (${todo.length} to record): ${v.direction}`);
    for (const l of todo) console.log(`${l.id}\t${l.text}`);
  }
}

const args = process.argv.slice(2);
if (args[0] === '--audition') audition(args.slice(1));
else if (args[0] === '--measure') measure();
else if (args[0] === '--sheet') sheet(args.slice(1));
else generate(new Set(args));
