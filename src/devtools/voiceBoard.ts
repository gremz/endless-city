import { isBarkVoice, isRecorded, VOICE_LINES, VOICES, voiceFile, type VoiceDef, type VoiceId } from '../ai/voiceLines';

/**
 * Dev page (/voices.html): play every generated voice line, and compare the candidate voices
 * rendered by `npm run voices -- --audition`, dry or as heard in game from ~45 m away.
 */

/** One clip from `npm run voices -- --audition` (see scripts/make-voices.ts). */
interface AuditionClip {
  group: string;
  voice: string;
  treatment: string;
  sample: string;
  /** The part this voice would go to. */
  use: VoiceId;
  file: string;
  def: Omit<VoiceDef, 'name'>;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const base = import.meta.env.BASE_URL;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};

let ctx: AudioContext | null = null;
let reverb: ConvolverNode | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();
let current: { src: AudioBufferSourceNode; button: HTMLButtonElement } | null = null;

/** A short, dark room: enough to hear what the game's reverb send does to a line. */
function makeReverb(c: AudioContext): ConvolverNode {
  const len = Math.floor(c.sampleRate * 1.6);
  const ir = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  const conv = c.createConvolver();
  conv.buffer = ir;
  return conv;
}

function load(url: string): Promise<AudioBuffer | null> {
  let p = buffers.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((data) => ctx!.decodeAudioData(data))
      .catch(() => null);
    buffers.set(url, p);
  }
  return p;
}

async function play(url: string, button: HTMLButtonElement): Promise<void> {
  ctx ??= new AudioContext();
  reverb ??= makeReverb(ctx);
  const c = ctx;
  if (current) {
    current.src.stop();
    current.button.classList.remove('playing');
    const same = current.button === button;
    current = null;
    if (same) return;
  }
  const buf = await load(url);
  if (!buf) {
    button.textContent = 'missing';
    button.classList.add('missing');
    return;
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  const far = $<HTMLInputElement>('far').checked;
  if (far) {
    // Roughly the game's distance filter and falloff at 45 m, plus its reverb send.
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 6300;
    const dry = c.createGain();
    dry.gain.value = 0.55;
    const wet = c.createGain();
    wet.gain.value = 0.2;
    src.connect(lp);
    lp.connect(dry).connect(c.destination);
    lp.connect(wet).connect(reverb!).connect(c.destination);
  } else {
    src.connect(c.destination);
  }
  button.classList.add('playing');
  current = { src, button };
  src.onended = () => {
    button.classList.remove('playing');
    if (current?.src === src) current = null;
  };
  src.start();
}

function playButton(url: string, label = '▶'): HTMLButtonElement {
  const b = el('button', label);
  b.onclick = () => void play(url, b);
  return b;
}

/** Game lines, by speaker. */
function renderLines(): void {
  const table = $<HTMLTableElement>('lines');
  for (const l of VOICE_LINES) {
    const tr = el('tr');
    const td = el('td');
    // Not recorded yet: nothing to play.
    if (isRecorded(l)) td.append(playButton(`${base}${voiceFile(l.id)}`));
    else td.textContent = '–';
    tr.append(td, el('td', isBarkVoice(l.voice) ? l.voice : VOICES[l.voice].name, 'who'), el('td', l.cue), el('td', l.text, 'text'));
    table.append(tr);
  }
}

async function copyDef(role: VoiceId, def: Omit<VoiceDef, 'name'>): Promise<void> {
  const text = `${role}: ${JSON.stringify({ ...def, name: VOICES[role].name }).replace(/"(\w+)":/g, '$1: ').replace(/,/g, ', ')},`;
  try {
    await navigator.clipboard.writeText(text);
    $('copied').textContent = `copied: ${text}`;
  } catch {
    $('copied').textContent = text;
  }
}

/** Candidate voices, a table per audition group: a row per voice, a column per sample and delivery. */
async function renderAudition(): Promise<void> {
  const box = $('audition');
  const res = await fetch(`${base}voice/audition/manifest.json`).catch(() => null);
  if (!res?.ok) {
    box.textContent = 'No audition clips yet: run `npm run voices -- --audition`.';
    return;
  }
  const clips = (await res.json()) as AuditionClip[];
  const uniq = <T,>(xs: T[]) => [...new Set(xs)];
  const tables = uniq(clips.map((c) => c.group)).map((group) => {
    const mine = clips.filter((c) => c.group === group);
    const treatments = uniq(mine.map((c) => c.treatment));
    const samples = uniq(mine.map((c) => c.sample));
    const table = el('table');
    const head = el('tr');
    head.append(el('th', group));
    for (const sample of samples) for (const t of treatments) head.append(el('th', `${sample} · ${t}`));
    table.append(head);
    for (const v of uniq(mine.map((c) => c.voice))) {
      const tr = el('tr');
      tr.append(el('td', v, 'who'));
      for (const sample of samples) {
        for (const t of treatments) {
          const td = el('td');
          const clip = mine.find((c) => c.voice === v && c.sample === sample && c.treatment === t);
          if (clip) {
            const use = el('button', `use for ${VOICES[clip.use].name.toLowerCase()}`, 'pick');
            use.onclick = () => void copyDef(clip.use, clip.def);
            td.append(playButton(`${base}${clip.file}`), ' ', use);
          }
          tr.append(td);
        }
      }
      table.append(tr);
    }
    return table;
  });
  box.replaceChildren(...tables.flatMap((t) => [t, el('br')]));
  box.classList.remove('hint');
}

renderLines();
void renderAudition();
