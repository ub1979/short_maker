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
    data = run_whisper_align(media, model, opts) if opts.get("align") else run_whisper(media, model, opts)
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
    return _rms(wav, s, e) < 0.005  # about -46 dBFS


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


# ---------------- Whisper forced alignment (lyrics auto-sync) ----------------

ALIGN_WIN = 30.0     # Whisper sees 30 s of audio at a time
ALIGN_TAIL = 4.0     # a line ending this close to a window's end is redone in the next window
ALIGN_TOKENS = 200   # text per window (the decoder takes 448 tokens)
ALIGN_AHEAD = 6.0    # the next line was heard this far ahead: jump to it


def _rms(wav, s: float, e: float) -> float:
    part = wav[int(s * SR):max(int(s * SR) + 1, int(e * SR))]
    return float((part.astype("float64") ** 2).mean() ** 0.5)


def _silent_share(wav, s: float, e: float, step: float = 0.25) -> float:
    """Share of the span (in 0.25 s slices) that is near silent."""
    n = max(1, int((e - s) / step))
    return sum(_rms(wav, s + i * step, s + (i + 1) * step) < 0.005 for i in range(n)) / n


def _next_sound(wav, t: float, step: float = 0.25):
    """First time at or after t where the audio stops being near silent."""
    n = int(step * SR)
    for i in range(int(t * SR), len(wav) - n, n):
        if _rms(wav, i / SR, (i + n) / SR) >= 0.01:
            return i / SR
    return None


def _align_text(t: str) -> str:
    """Text as it's sung: no markdown/brackets, and stretched words back to normal
    ("youuuuu..." -> "you"), so the tokens look like words Whisper knows."""
    import re
    t = re.sub(r"\*+|\[.*?\]", " ", t)
    t = re.sub(r"(\w)\1{2,}", r"\1", t)
    return re.sub(r"\s+", " ", t).strip()


def run_whisper_align(media: str, model_path: str, o: dict):
    """Time the user's exact lyric lines with Whisper (forced alignment).

    Instead of asking Whisper what it hears and matching that up, we hand it the
    lyrics and ask only *when* each word is sung: the lyric tokens are fed through
    the decoder and the cross-attention alignment heads + DTW place every word in
    the audio (the same machinery Whisper uses for word timestamps).

    Whisper sees 30 s at a time, so we walk through the song: align the next lines
    in a 30 s window, keep the lines that end well inside it, start the next window
    where the last kept line ended. Lines heard by a normal Whisper pass ("rough")
    let us jump over long instrumental breaks; user times ("fixed") are kept and
    restart the walk there.

    opts: {"align": true, "lines": [text], "rough": [start | null], "fixed": {"i": start},
           "language": "en" | "ur" | null}
    Returns {"engine": "whisper-align", "times": [[start, end] | null], "language"}.
    """
    try:
        import mlx.core as mx
        from mlx_whisper.audio import HOP_LENGTH, N_FRAMES, N_SAMPLES, log_mel_spectrogram
        from mlx_whisper.timing import find_alignment
        from mlx_whisper.tokenizer import get_tokenizer
        from mlx_whisper.transcribe import ModelHolder
    except ImportError:
        print("mlx-whisper is not installed (it needs an Apple Silicon Mac).", file=sys.stderr)
        return None
    texts = list(o.get("lines") or [])
    rough = list(o.get("rough") or [None] * len(texts))
    fixed = {int(k): float(v) for k, v in (o.get("fixed") or {}).items()}
    wav = _load_audio(media)
    if wav is None:
        return None
    fps = SR / HOP_LENGTH
    model = ModelHolder.get_model(model_path, mx.float16)
    mel = log_mel_spectrogram(wav, n_mels=model.dims.n_mels, padding=N_SAMPLES)
    content = mel.shape[0] - N_FRAMES
    lang = o.get("language")
    if not lang:
        lang = "en"
        if model.is_multilingual:
            _, probs = model.detect_language(mel[:N_FRAMES].astype(mx.float16))
            lang = max(probs, key=probs.get)
    tok = get_tokenizer(model.is_multilingual, num_languages=model.num_languages, language=lang, task="transcribe")
    toks = [tok.encode(" " + _align_text(t)) for t in texts]
    times: list = [None] * len(texts)

    # Where singing starts: skip the intro music, or the first line soaks it all up.
    first = [x for x in rough if x is not None]
    voice = voice_parts(media)
    starts = ([voice[0][0]] if voice else []) + first[:1]
    t = max(0.0, min(starts) - 0.5) if starts else 0.0

    k, lead = 0, None
    while k < len(texts):
        if k in fixed:  # the user's own time: keep it and carry on from there
            times[k] = [fixed[k], None]
            t, lead, k = fixed[k], k, k + 1  # its words still lead the next window
            continue
        if not toks[k]:
            k += 1
            continue
        # The next line was clearly heard well ahead (a break, or a slow part): start
        # its window just before. Heard times were at most ~2.7 s off in our tests,
        # hence the 3 s margin. (Only for the very next line: unheard lines before a
        # heard one may still come before the break.)
        if rough[k] is not None and rough[k] - t > ALIGN_AHEAD:
            t = rough[k] - 3.0
        f0 = int(t * fps)
        if f0 >= content:
            break
        end_t = t + ALIGN_WIN
        # lines for this window: stop at the user's next time and at the token budget
        n, ntok = 0, 0
        while k + n < len(texts) and (k + n) not in fixed:
            if n and ntok + len(toks[k + n]) > ALIGN_TOKENS:
                break
            r = rough[k + n]
            if n and r is not None and r > end_t + 6:
                break
            ntok += len(toks[k + n])
            n += 1
        # the user's line just before (timed by them) leads the text, so its words
        # don't end up inside the next line; its time isn't touched
        lead_toks = toks[lead] if lead is not None else []
        flat = lead_toks + [x for i in range(k, k + n) for x in toks[i]]
        # Only a few lines (before a break, or the song's end)? Give them a matching
        # amount of audio, ~5 s a line: a short line can't be found in 30 s of music.
        nf = min(N_FRAMES, content - f0, int(fps * max(10.0, 5.0 * n + 4.0)))
        end_t = t + nf / fps
        words = find_alignment(model, tok, flat, mel[f0:f0 + N_FRAMES].astype(mx.float16), nf) if flat else []
        bounds, c = [], len(lead_toks)
        for i in range(k, k + n):
            bounds.append((c, c + len(toks[i])))
            c += len(toks[i])
        # The alignment hands any pause (or the intro music, at a window's first frame)
        # to the word after it, so a line's first word can look seconds long and the
        # line shows too early. Like Whisper's own word timing, a line's first word
        # that's far longer than usual is cut down to a normal length.
        durs = sorted(float(w.end - w.start) for w in words if w.word.strip() and w.end > w.start)
        med = durs[len(durs) // 2] if durs else 0.4
        longest = max(1.0, 3 * med)
        line_t: dict[int, list] = {}
        pos = 0
        for w in words:
            li = next((j for j, (a, b) in enumerate(bounds) if a <= pos < b), None)
            pos += len(w.tokens)
            if li is None or not w.word.strip():
                continue
            s, e = t + float(w.start), t + float(w.end)
            if li not in line_t and e - s > longest:
                s = e - max(0.5, 2 * med)
            line_t.setdefault(li, [s, e])[1] = e
        last = f0 + nf >= content
        nxt_fixed = fixed.get(k + n)
        acc = 0
        silent_first = False
        for j in range(n):
            if j not in line_t or (not last and line_t[j][1] > end_t - ALIGN_TAIL):
                break
            if nxt_fixed is not None and line_t[j][0] >= nxt_fixed:
                break
            if _silent_share(wav, *line_t[j]) >= 0.5:  # singing is never silent: placed in a gap
                silent_first = j == 0
                break
            times[k + j] = [round(line_t[j][0], 3), round(line_t[j][1], 3)]
            acc += 1
        lead = None
        if acc == 0 and silent_first:  # skip the silence and try these lines again
            nt = _next_sound(wav, line_t[0][0])
            if nt is not None and nt > t + 0.5:
                t = nt - 0.3
                continue
        if acc == 0:  # always move forward
            if 0 in line_t:
                times[k] = [round(line_t[0][0], 3), round(line_t[0][1], 3)]
            acc = 1
        if last and acc < n and all(j in line_t for j in range(n)):
            for j in range(acc, n):  # end of the song: nothing more to wait for
                times[k + j] = [round(line_t[j][0], 3), round(line_t[j][1], 3)]
            acc = n
        k += acc
        prev = times[k - 1]
        t = max(t + 1.0, (prev[1] if prev and prev[1] else t + ALIGN_WIN / 2) - 0.3)
    return {"engine": "whisper-align", "times": times, "language": lang}


if __name__ == "__main__":
    sys.exit(main())
