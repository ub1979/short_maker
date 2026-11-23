"""Run in a subprocess: python -m app.transcribe_worker <media> <out.json> <model> [opts.json]

Transcribes with mlx-whisper (<model> e.g. "mlx-community/whisper-small-mlx") and
uses Silero VAD as a second opinion against hallucinations: Whisper likes to invent
text ("Thank you for watching", looped lines) over instrumental parts and silence.

Silero is trained on speech, and on songs it misses real singing over loud music
(on "warm up" it hears no voice in a 19 s chanted part). So it never deletes text by
itself: a Whisper segment is dropped only when Silero hears no voice anywhere in it
AND Whisper itself said "no speech" or the audio there is near silent (see
_suspicious). Dropped segments are
reported in the output so the app can show them.

Kept out of the server process so a crash or the large model doesn't take the
server down, and memory is released when transcription finishes.
Output JSON: {"language", "engine", "segments": [{start, end, text, words: [{w, s, e}]}],
              "voice": [[start, end]...] | null, "dropped": [{start, end, text}]}
"""
import json
import subprocess
import sys

SR = 16000


def main() -> int:
    media, out, model = sys.argv[1], sys.argv[2], sys.argv[3]
    opts = {}
    if len(sys.argv) > 4:
        with open(sys.argv[4]) as f:
            opts = json.load(f)
    data = run_whisper(media, model, opts)
    if data is None:
        return 2
    with open(out, "w") as f:
        json.dump(data, f, ensure_ascii=False)
    return 0


def _load_audio(media: str, af: str | None = None):
    """16 kHz mono float32 via ffmpeg (handles any container the app accepts)."""
    import numpy as np
    cmd = ["ffmpeg", "-v", "error", "-i", media, "-vn"] + (["-af", af] if af else []) + \
          ["-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    try:
        r = subprocess.run(cmd, capture_output=True)
    except FileNotFoundError:
        print("ffmpeg is not installed (brew install ffmpeg).", file=sys.stderr)
        return None
    if r.returncode != 0:
        msg = [l for l in r.stderr.decode(errors="replace").splitlines() if l.strip()][-1:] or ["unknown ffmpeg error"]
        print(f"Couldn't read the audio: {msg[0][:250]}", file=sys.stderr)
        return None
    return np.frombuffer(r.stdout, dtype=np.float32).copy()


# ---------------- Silero VAD ----------------

def voice_parts(media: str):
    """Where Silero hears a voice, as [[start, end]...] in seconds, or None if it can't run.

    The audio is cut to the voice band (200-3500 Hz) first and the threshold is low:
    on songs that keeps far more of the singing (on "warm up", 36 of 471 words fell
    outside instead of 361). Being generous here only means fewer drops."""
    try:
        import torch
        from silero_vad import get_speech_timestamps, load_silero_vad
    except ImportError:
        print("Silero VAD isn't installed, so hallucinations can't be checked. Run ./start.sh again.", file=sys.stderr)
        return None
    wav = _load_audio(media, "highpass=f=200,lowpass=f=3500")
    if wav is None or not len(wav):
        return None
    ts = get_speech_timestamps(torch.from_numpy(wav), load_silero_vad(), sampling_rate=SR, threshold=0.15,
                               min_silence_duration_ms=700, speech_pad_ms=400, return_seconds=True)
    return [[round(float(t["start"]), 2), round(float(t["end"]), 2)] for t in ts]


def _has_voice(voice, s: float, e: float) -> bool:
    return any(a < e and s < b for a, b in voice)


def _suspicious(seg: dict, wav, s: float, e: float) -> bool:
    """Whisper itself thought there was no speech, or the audio there is near silent.

    mlx-whisper scores whole 30 s windows, not single lines, so on songs the scores
    are rough: real chanted lyrics in "warm up" score 0.30-0.67 "no speech" and
    repetitive lyrics look like loops. Only a strong no-speech score counts.
    (Calibrated on "warm up", "aye watan" and a clip starting with 30 s of silence,
    where Whisper invented " you" with a score of 0.94.)"""
    if seg.get("no_speech_prob", 0) >= 0.8:
        return True
    part = wav[int(s * SR):max(int(s * SR) + 1, int(e * SR))]
    return float((part.astype("float64") ** 2).mean() ** 0.5) < 0.005  # about -46 dBFS


# ---------------- Whisper ----------------

def run_whisper(media: str, model: str, o: dict):
    # Options from lyrics auto-sync: {"prompt": words to expect, "language": "en"/"ur"/null}.
    # Songs loop easily, so Whisper never conditions on its own earlier output, and
    # it skips silence before text it isn't sure about.
    opts = {"condition_on_previous_text": False, "hallucination_silence_threshold": 2.0}
    if o:
        opts.update(initial_prompt=o.get("prompt") or None, language=o.get("language") or None)
    try:
        import mlx_whisper
    except ImportError:
        print("mlx-whisper is not installed (it needs an Apple Silicon Mac).", file=sys.stderr)
        return None
    wav = _load_audio(media)
    if wav is None:
        return None
    voice = voice_parts(media)
    result = mlx_whisper.transcribe(wav, path_or_hf_repo=model, word_timestamps=True, **opts)
    segments, dropped = [], []
    for seg in result.get("segments", []):
        words = [
            {"w": w["word"].strip(), "s": round(float(w["start"]), 3), "e": round(float(w["end"]), 3)}
            for w in seg.get("words", []) if w.get("word", "").strip()
        ]
        s, e, text = round(float(seg["start"]), 3), round(float(seg["end"]), 3), seg["text"].strip()
        if voice is not None and not _has_voice(voice, s, e) and _suspicious(seg, wav, s, e):
            dropped.append({"start": s, "end": e, "text": text})
            continue
        segments.append({"start": s, "end": e, "text": text, "words": words})
    if dropped:
        print(f"dropped {len(dropped)} segment(s) with no voice: " +
              "; ".join(f"{d['start']:.0f}s {d['text'][:40]!r}" for d in dropped), file=sys.stderr)
    return {"language": result.get("language"), "engine": "whisper", "segments": segments,
            "voice": voice, "dropped": dropped}


if __name__ == "__main__":
    sys.exit(main())
