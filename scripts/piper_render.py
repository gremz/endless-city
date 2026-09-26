"""Render voice lines with Piper: reads a JSON job on stdin (see make-voices.ts), writes MP3s.

Needs `pip install piper-tts soundfile pyworld`. Voices are downloaded into the job's voices dir
on first use. Pitch and formant changes go through the WORLD vocoder: pitch moves without the
slowed-tape sound of resampling, and a formant factor below 1 gives a bigger, darker voice. Then
each clip is trimmed, long pauses are shortened, and it is peak-normalised.

Prints {id: seconds} as JSON on stdout; progress goes to stderr.
"""

import json
import sys
from pathlib import Path

import numpy as np
import pyworld as pw
import soundfile as sf
from piper import PiperVoice, SynthesisConfig
from piper.download_voices import download_voice

PAD = 0.06  # seconds of silence either side
PEAK = 0.9
SILENCE = 0.01
MAX_GAP = 0.5  # longest pause kept (Piper leaves up to ~2 s between sentences)
FRAME_MS = 5.0


def shorten_gaps(audio: np.ndarray, rate: int) -> np.ndarray:
    """Cut every quiet stretch longer than MAX_GAP down to MAX_GAP (keeping its middle)."""
    win = int(rate * 0.02)
    frames = len(audio) // win
    quiet = [float(np.max(np.abs(audio[i * win : (i + 1) * win]))) < SILENCE * 3 for i in range(frames)]
    keep = int(MAX_GAP * rate / win)
    parts = []
    start = 0
    i = 0
    while i < frames:
        if not quiet[i]:
            i += 1
            continue
        j = i
        while j < frames and quiet[j]:
            j += 1
        if j - i > keep:
            parts.append(audio[start : (i + keep // 2) * win])
            start = (j - keep // 2) * win
        i = j
    parts.append(audio[start:])
    return np.concatenate(parts)


def reshape(audio: np.ndarray, rate: int, pitch: float, formant: float) -> np.ndarray:
    """Move the pitch by `pitch` and the formants by `formant` (WORLD analysis and resynthesis)."""
    x = audio.astype(np.float64)
    f0, t = pw.harvest(x, rate, frame_period=FRAME_MS)
    sp = pw.cheaptrick(x, f0, t, rate)
    ap = pw.d4c(x, f0, t, rate)
    if formant != 1:
        # A formant at f moves to f * formant: read each bin from bin / formant.
        bins = np.arange(sp.shape[1])
        src = np.minimum(bins / formant, bins[-1])
        sp = np.stack([np.interp(src, bins, frame) for frame in sp])
    y = pw.synthesize(f0 * pitch, sp, ap, rate, frame_period=FRAME_MS)
    return y.astype(np.float32)


def render(voice: PiperVoice, line: dict) -> tuple[np.ndarray, int]:
    cfg = SynthesisConfig(
        speaker_id=line.get("speakerId"),
        length_scale=line["lengthScale"],
        noise_scale=line.get("noiseScale"),
        noise_w_scale=line.get("noiseW"),
    )
    chunks = list(voice.synthesize(line["text"], cfg))
    rate = chunks[0].sample_rate
    audio = np.concatenate([c.audio_float_array for c in chunks]).astype(np.float32)
    pitch = line.get("pitch", 1)
    formant = line.get("formant", 1)
    if pitch != 1 or formant != 1:
        audio = reshape(audio, rate, pitch, formant)
    loud = np.nonzero(np.abs(audio) > SILENCE)[0]
    if len(loud):
        audio = shorten_gaps(audio[loud[0] : loud[-1] + 1], rate)
    pad = np.zeros(int(PAD * rate), dtype=np.float32)
    audio = np.concatenate([pad, audio, pad])
    peak = float(np.max(np.abs(audio))) or 1.0
    return audio * (PEAK / peak), rate


def main() -> None:
    job = json.load(sys.stdin)
    voices_dir = Path(job["voicesDir"])
    out_dir = Path(job["outDir"])
    voices_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    loaded: dict[str, PiperVoice] = {}
    durations: dict[str, float] = {}
    for line in job["lines"]:
        model = line["model"]
        if model not in loaded:
            download_voice(model, voices_dir)
            loaded[model] = PiperVoice.load(voices_dir / f"{model}.onnx")
        voice = loaded[model]
        speaker = line.get("speaker")
        if speaker is not None:
            ids = voice.config.speaker_id_map or {}
            if speaker not in ids:
                raise SystemExit(f"{model} has no speaker '{speaker}' (it has: {', '.join(ids)})")
            line = {**line, "speakerId": ids[speaker]}
        audio, rate = render(voice, line)
        out = out_dir / f"{line['id']}.mp3"
        # compression_level 0: the best quality the MP3 encoder offers.
        sf.write(out, audio, rate, format="MP3", compression_level=0)
        durations[line["id"]] = round(len(audio) / rate, 2)
        print(f"{out}  {durations[line['id']]:.1f}s  {out.stat().st_size // 1024} KB", file=sys.stderr, flush=True)
    json.dump(durations, sys.stdout)


if __name__ == "__main__":
    main()
