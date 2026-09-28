/**
 * Spoken lines, recorded in ElevenLabs (or generated with Piper, `npm run voices`) into
 * `public/voice/<id>.mp3`. Pure data: the bots pick lines by cue, the audio engine loads the clips,
 * the HUD captions them. A line without a clip yet is still captioned, just not heard.
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

/** A voice in the game: rendered by `npm run voices` (Piper), or recorded by hand in ElevenLabs. */
export type Voice = { name: string } & (
  | ({ source: 'piper' } & VoiceDef)
  | {
      source: 'elevenlabs';
      /** How to design the voice in ElevenLabs. */
      direction: string;
    }
);

/** The street gang's and the terrorist cell's voices: squads bark in these (see barks.ts). */
export type Faction = 'gang' | 'cell';
export const FACTION_VOICES = { gang: ['gang1', 'gang2'], cell: ['cell1', 'cell2'] } as const;
export type BarkVoiceId = (typeof FACTION_VOICES)[Faction][number];

export type VoiceId = 'gunman' | 'shover' | 'officer' | 'dispatch' | BarkVoiceId;

export const VOICES: Record<VoiceId, Voice> = {
  // The opening's scene.
  gunman: { source: 'elevenlabs', direction: 'Male, 30s–40s, low and menacing, unhurried.', name: 'Gunman' },
  shover: { source: 'elevenlabs', direction: 'Male, 20s–30s, sneering street thug.', name: 'Thug' },
  officer: { source: 'elevenlabs', direction: 'Male police officer, shaken, voice wobbling.', name: 'Officer' },
  // The intro's police radio. Recorded clean: the game adds the radio sound (PlayOptions.radio).
  dispatch: {
    source: 'elevenlabs',
    direction: 'Police radio dispatcher, female, 30s–40s, calm, clipped and professional; even pace, urgent underneath but never rushed.',
    name: 'Dispatch',
  },
  // Squad barks: both voices of a faction record the same lines. Captioned with the bot's own name.
  gang1: { source: 'elevenlabs', direction: 'Male, 20s, fast and cocky street voice, loud, a little reckless.', name: 'Gang member' },
  gang2: { source: 'elevenlabs', direction: 'Male, 30s, deeper and gravelly, slower: the older head of the crew.', name: 'Gang member' },
  cell1: { source: 'elevenlabs', direction: 'Male, 30s–40s, cold and clipped, calm under fire, military cadence, neutral accent.', name: 'Terrorist' },
  cell2: { source: 'elevenlabs', direction: 'Male, 40s, lower and harder, a terse commander who barely raises his voice even when hit.', name: 'Terrorist' },
};

/** Cues squads bark on (see barks.ts for when each one fires). */
export type BarkCue =
  | 'idle'
  | 'suspicious'
  | 'spotted'
  | 'flank'
  | 'hurt'
  | 'reload'
  | 'throw'
  | 'incoming'
  | 'blinded'
  | 'manDown'
  | 'lastAlive'
  | 'retreat'
  | 'cover'
  | 'lost'
  | 'giveUp'
  | 'kill'
  | 'taunt';

/** When a line is said. */
export type VoiceCue = 'plead' | 'warn' | 'execute' | 'after' | 'thanks' | 'intro' | BarkCue;

export interface VoiceLine {
  id: string;
  voice: VoiceId;
  cue: VoiceCue;
  text: string;
}

/** What each faction says, per cue. "He" is the player. Clean: no swearing. */
export const BARK_SCRIPT: Record<Faction, Record<BarkCue, readonly string[]>> = {
  gang: {
    idle: [
      'Man, how long we gotta stand out here?',
      'Boss said nobody gets past this block. Nobody.',
      "You hear that? ...Nah. Nothing.",
      "When this is over, I'm sleeping for a week.",
      'Keep your eyes open. Cops been sniffing around all week.',
    ],
    suspicious: ['Yo, you hear that?', "Somebody's out there.", "Who's there? Show yourself!", 'Go check it out. Go on.'],
    spotted: ['Cop! Right there!', 'There he is! Light him up!', 'We got company!', 'SWAT! They sent SWAT!'],
    flank: ["I'm going around the side!", "Keep him busy, I'll get behind him!", 'Cut him off! Go, go!'],
    hurt: ["Agh! I'm hit!", 'He got me!', 'Ugh... that hurt!'],
    reload: ['Reloading! Cover me!', "I'm empty!", 'Hold up, hold up, reloading!'],
    throw: ['Catch this!', 'Heads up, cop!', 'Fire in the hole!'],
    incoming: ['Grenade! Move!', 'Get down!', 'Oh no, run!'],
    blinded: ["I can't see! I can't see!", 'My eyes!', "Everything's white!"],
    manDown: ["He's down! He's down!", 'No! They got him!', 'Man down!', "You're gonna pay for that!"],
    lastAlive: ["It's just me now... it's just me.", "Everybody's gone? Everybody?", 'Okay. You want me? Come get me!'],
    retreat: ["I'm falling back!", "Too hot! I'm out!", 'Get me outta here!'],
    cover: ['Taking cover!', 'Get behind something!', "I'm pinned down here!"],
    lost: ["Where'd he go?", 'Lost him! Anybody see him?', "He's hiding. Find him!"],
    giveUp: ['Guess he ran off.', 'Nothing. Back to your spot.', "Must've been the wind."],
    kill: ['Down he goes!', "Who's next, huh?", 'Stay down, cop.'],
    taunt: ['Come on out, cop!', "You can't hide in there forever!", "What's wrong? Scared?", 'This is our street!'],
  },
  cell: {
    idle: [
      'Stay sharp. Their tactical teams will come.',
      'Check your sector. Report anything.',
      'Radio check. Hold position.',
      'Patience. We hold until the deadline.',
    ],
    suspicious: ['Movement. Check it.', 'Did you hear that? Investigate.', "Something's out there. Weapons up."],
    spotted: ['Contact! Contact!', 'Hostile, front!', 'Tactical unit! Engage!', 'Enemy sighted. Open fire!'],
    flank: ['Flanking. Keep him pinned.', 'Moving to flank.', "Suppress him. I'm going around."],
    hurt: ["I'm hit!", 'Took one. Still in it.', 'Hit! Keep firing!'],
    reload: ['Reloading!', 'Changing magazine!', 'Cover me, reloading!'],
    throw: ['Fire in the hole!', 'Grenade out!', 'Throwing! Heads down!'],
    incoming: ['Grenade! Take cover!', 'Incoming! Move!', 'Scatter!'],
    blinded: ["Flashbang! I'm blind!", "Can't see! Cover me!"],
    manDown: ['Man down!', 'We lost one!', "He's down. Stay focused!"],
    lastAlive: ["I'm the only one left. So be it.", "Squad's gone. I'll finish this myself."],
    retreat: ['Falling back!', 'Pulling out! Cover me!', 'Withdrawing!'],
    cover: ['Taking cover!', 'Moving to cover!', 'Get down, find cover!'],
    lost: ['Lost visual.', 'Where is he? Report!', "He's repositioning. Watch the corners."],
    giveUp: ["Area's clear. Back to positions.", 'Nothing. Resume watch.', "Stay alert. He's still out there."],
    kill: ['Target down.', 'Hostile neutralised.', 'One less.'],
    taunt: ['You cannot hide from us.', 'You are surrounded. Give up.', 'No one is coming for you.'],
  },
};

const SCENE_LINES: readonly VoiceLine[] = [
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

/** The intro's radio call, in order (see game/Intro.ts for when each one plays). */
export const INTRO_LINES: readonly VoiceLine[] = [
  { id: 'dispatch_intro_1', voice: 'dispatch', cue: 'intro', text: 'All units, be advised. An officer has been taken hostage by the plaza fountain.' },
  { id: 'dispatch_intro_2', voice: 'dispatch', cue: 'intro', text: "Two armed suspects. They're threatening to execute him. You're the closest unit." },
  { id: 'dispatch_intro_3', voice: 'dispatch', cue: 'intro', text: 'Get him out alive.' },
];

/** Every faction line, once per voice of the faction: `<voice>_<cue>_<n>`. */
function barkLines(): VoiceLine[] {
  const out: VoiceLine[] = [];
  for (const faction of Object.keys(FACTION_VOICES) as Faction[]) {
    for (const voice of FACTION_VOICES[faction]) {
      for (const [cue, texts] of Object.entries(BARK_SCRIPT[faction]) as [BarkCue, readonly string[]][]) {
        texts.forEach((text, i) => out.push({ id: `${voice}_${cue}_${i + 1}`, voice, cue, text }));
      }
    }
  }
  return out;
}

export const VOICE_LINES: readonly VoiceLine[] = [...SCENE_LINES, ...INTRO_LINES, ...barkLines()];

export const VOICE_BY_ID: ReadonlyMap<string, VoiceLine> = new Map(VOICE_LINES.map((l) => [l.id, l]));

/** Published path of a line's clip (relative to the site base). */
export const voiceFile = (id: string): string => `voice/${id}.mp3`;

/** Whether a line's clip has been recorded (and measured: `npm run voices -- --measure`). */
export const isRecorded = (l: VoiceLine): boolean => VOICE_DURATIONS[l.id] !== undefined;

/** Seconds a line takes to say: the clip's length, or a guess for a line not recorded yet. */
export function lineSeconds(l: VoiceLine): number {
  const v = VOICES[l.voice];
  return VOICE_DURATIONS[l.id] ?? 0.6 + l.text.length * 0.07 * (v.source === 'piper' ? v.lengthScale : 1);
}

const BY_CUE = new Map<string, VoiceLine[]>();
for (const l of VOICE_LINES) {
  const key = `${l.voice}:${l.cue}`;
  let list = BY_CUE.get(key);
  if (!list) BY_CUE.set(key, (list = []));
  list.push(l);
}
/** The lines for `cue` in `voice`, e.g. to pick one at random. */
export function linesFor(voice: VoiceId, cue: VoiceCue): readonly VoiceLine[] {
  return BY_CUE.get(`${voice}:${cue}`) ?? [];
}

/** A squad voice (captioned with the speaker's own name, from closer by). */
export const isBarkVoice = (v: VoiceId): v is BarkVoiceId => v.startsWith('gang') || v.startsWith('cell');
