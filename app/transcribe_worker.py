"""Run in a subprocess: python -m app.transcribe_worker <media> <out.json> <model> [opts.json]

<model> picks the engine:
  - "Qwen/Qwen3-ASR-..."  -> Qwen3-ASR + Qwen3-ForcedAligner (word times). Best for
    English and ~29 other languages, but it has NO Urdu (it hears it as Hindi/Arabic).
    Its forced aligner knows only 11 languages (see ALIGN_LANGS).
  - anything else          -> mlx-whisper (e.g. "mlx-community/whisper-small-mlx").

Kept out of the server process so a crash or the large model doesn't take the
server down, and memory is released when transcription finishes.
Output JSON: {"language", "engine", "segments": [{start, end, text, words: [{w, s, e}]}]}
"""
import json
import re
import subprocess
import sys
import unicodedata

QWEN_ALIGNER = "Qwen/Qwen3-ForcedAligner-0.6B"


def is_qwen(model: str) -> bool:
    return model.lower().startswith("qwen/")


def main() -> int:
    media, out, model = sys.argv[1], sys.argv[2], sys.argv[3]
    opts = {}
    if len(sys.argv) > 4:
        with open(sys.argv[4]) as f:
            opts = json.load(f)
    if model == "qwen-align":
        data = run_qwen_align(media, opts)
    else:
        data = run_qwen(media, model) if is_qwen(model) else run_whisper(media, model, opts)
    if data is None:
        return 2
    with open(out, "w") as f:
        json.dump(data, f, ensure_ascii=False)
    return 0


# ---------------- Whisper ----------------

def run_whisper(media: str, model: str, o: dict):
    # Options are used by lyrics auto-sync: {"prompt": words to expect, "language": "en"/"ur"/null}.
    # Songs loop easily, so with options we also stop Whisper conditioning on its own output.
    opts = {}
    if o:
        opts = {"initial_prompt": o.get("prompt") or None, "language": o.get("language") or None,
                "condition_on_previous_text": False, "hallucination_silence_threshold": 2.0}
    try:
        import mlx_whisper
    except ImportError:
        print("mlx-whisper is not installed (it needs an Apple Silicon Mac).", file=sys.stderr)
        return None
    result = mlx_whisper.transcribe(media, path_or_hf_repo=model, word_timestamps=True, **opts)
    segments = []
    for seg in result.get("segments", []):
        words = [
            {"w": w["word"].strip(), "s": round(float(w["start"]), 3), "e": round(float(w["end"]), 3)}
            for w in seg.get("words", []) if w.get("word", "").strip()
        ]
        segments.append({"start": round(float(seg["start"]), 3), "end": round(float(seg["end"]), 3),
                         "text": seg["text"].strip(), "words": words})
    return {"language": result.get("language"), "engine": "whisper", "segments": segments}


# ---------------- Qwen3-ASR ----------------

def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s).casefold()
    return "".join(ch for ch in s if unicodedata.category(ch)[0] in "LN")


def _load_audio(media: str):
    """16 kHz mono float32 via ffmpeg (handles any container the app accepts)."""
    import numpy as np
    try:
        r = subprocess.run(["ffmpeg", "-v", "error", "-i", media, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                           capture_output=True)
    except FileNotFoundError:
        print("ffmpeg is not installed (brew install ffmpeg).", file=sys.stderr)
        return None
    if r.returncode != 0:
        msg = [l for l in r.stderr.decode(errors="replace").splitlines() if l.strip()][-1:] or ["unknown ffmpeg error"]
        print(f"Couldn't read the audio: {msg[0][:250]}", file=sys.stderr)
        return None
    return np.frombuffer(r.stdout, dtype=np.float32).copy()


def run_qwen(media: str, model: str):
    try:
        import torch
        from qwen_asr import Qwen3ASRModel
    except ImportError:
        print("Qwen3-ASR is not installed. Run ./start.sh again to install it, or pick Whisper in AI & settings.",
              file=sys.stderr)
        return None
    wav = _load_audio(media)
    if wav is None:
        return None
    if len(wav) < 16000 * 0.5:
        return {"language": "", "engine": "qwen", "segments": []}
    dev = "mps" if torch.backends.mps.is_available() else ("cuda:0" if torch.cuda.is_available() else "cpu")
    dtype = torch.float32 if dev == "cpu" else torch.bfloat16
    asr = Qwen3ASRModel.from_pretrained(
        model, forced_aligner=QWEN_ALIGNER, forced_aligner_kwargs={"dtype": dtype, "device_map": dev},
        dtype=dtype, device_map=dev, max_inference_batch_size=4, max_new_tokens=2048)
    r = asr.transcribe(audio=(wav, 16000), return_time_stamps=True)[0]
    items = [(it.text, float(it.start_time), float(it.end_time)) for it in (r.time_stamps or []) if _norm(it.text)]
    return {"language": (r.language or "").split(",")[0].strip().lower(), "engine": "qwen",
            "segments": build_segments(r.text or "", items)}


_CJK = re.compile(r"[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]")
_OPENERS = set("([{\"'“‘«¿¡")


def _is_wordy(ch: str) -> bool:
    return bool(_norm(ch))


# ---------------- Qwen forced alignment (lyrics auto-sync) ----------------

ALIGN_WINDOW = 170.0  # the aligner takes at most 180 s of audio per call


def _script_language(texts) -> str:
    joined = "".join(texts)
    if re.search(r"[\u3040-\u30ff]", joined):
        return "Japanese"
    if re.search(r"[\uac00-\ud7af]", joined):
        return "Korean"
    if re.search(r"[\u4e00-\u9fff]", joined):
        return "Chinese"
    return "English"  # any space-separated language is split the same way


# The forced aligner knows only these 11 languages (its model config lists them).
# Keys are Whisper codes and Qwen-ASR names, as stored in transcripts.
ALIGN_LANGS = {
    "zh": "Chinese", "chinese": "Chinese", "yue": "Cantonese", "cantonese": "Cantonese",
    "en": "English", "english": "English", "de": "German", "german": "German",
    "es": "Spanish", "spanish": "Spanish", "fr": "French", "french": "French",
    "it": "Italian", "italian": "Italian", "pt": "Portuguese", "portuguese": "Portuguese",
    "ru": "Russian", "russian": "Russian", "ko": "Korean", "korean": "Korean",
    "ja": "Japanese", "japanese": "Japanese",
}


def run_qwen_align(media: str, opts: dict):
    """Time the user's own lyric lines with Qwen3-ForcedAligner.

    opts: {"lines": [text...], "fixed": {"<index>": start_seconds}, "skip": [index...]}
    Unlike recognising the words and matching them up, forced alignment is told the
    exact words, so every line gets a real time even in very repetitive songs.
    Songs longer than ~170 s are cut into windows at lines that Qwen clearly heard
    (and at lines the user timed), and each window is aligned on its own.
    Returns {"engine": "qwen-align", "times": [[start, end] | null per line], "heard": n}.
    """
    try:
        import torch
        from qwen_asr import Qwen3ForcedAligner
    except ImportError:
        print("Qwen3-ASR is not installed. Run ./start.sh again to install it.", file=sys.stderr)
        return None
    from app.lyrics_align import align_lyrics
    wav = _load_audio(media)
    if wav is None:
        return None
    sr = 16000
    dur = len(wav) / sr
    texts = list(opts.get("lines") or [])
    fixed = {int(k): float(v) for k, v in (opts.get("fixed") or {}).items()}
    skip = set(int(i) for i in (opts.get("skip") or []))
    dev = "mps" if torch.backends.mps.is_available() else ("cuda:0" if torch.cuda.is_available() else "cpu")
    dtype = torch.float32 if dev == "cpu" else torch.bfloat16
    # Which language is sung? The aligner knows only 11 languages, and lyrics in
    # English letters may still be sung in Urdu/Hindi, so we ask the audio when the
    # project's transcript doesn't already say. Qwen-ASR hears Urdu as "hindi".
    spoken = str(opts.get("spoken") or "").strip().lower()
    heard_words = None
    if dur > ALIGN_WINDOW or not spoken:
        from qwen_asr import Qwen3ASRModel
        asr = Qwen3ASRModel.from_pretrained("Qwen/Qwen3-ASR-0.6B", forced_aligner=QWEN_ALIGNER,
                                            forced_aligner_kwargs={"dtype": dtype, "device_map": dev},
                                            dtype=dtype, device_map=dev, max_inference_batch_size=4, max_new_tokens=2048)
        r = asr.transcribe(audio=(wav, sr), return_time_stamps=dur > ALIGN_WINDOW)[0]
        if dur > ALIGN_WINDOW:
            heard_words = [{"w": it.text, "s": float(it.start_time), "e": float(it.end_time)}
                           for it in (r.time_stamps or [])]
        if not spoken:  # a song can come back as several, e.g. "English,Arabic"
            spoken = ",".join(x.strip().lower() for x in (r.language or "").split(",") if x.strip())
        del asr
    if _CJK.search("".join(texts)) or re.search(r"[\u3040-\u30ff]", "".join(texts)):
        lang = _script_language(texts)
    elif not spoken:
        lang = "English"  # nothing recognisable was heard; split by spaces anyway
    else:
        # every language heard must be one the aligner knows (a song that's half
        # Urdu, heard as Hindi/Arabic, needs Whisper even if the rest is English)
        langs = [ALIGN_LANGS.get(x) for x in spoken.split(",")]
        if None in langs:
            return {"engine": "qwen-align", "unsupported": spoken}
        lang = max(set(langs), key=langs.count) if len(set(langs)) > 1 else langs[0]
    print(f"aligning as {lang} (heard: {spoken or 'unknown'})", file=sys.stderr)

    aligner = Qwen3ForcedAligner.from_pretrained(QWEN_ALIGNER, dtype=dtype, device_map=dev)
    words_of = lambda t: aligner.aligner_processor.encode_timestamp(t, lang)[0]  # noqa: E731
    sung = [i for i, t in enumerate(texts) if i not in skip and words_of(t)]
    times: list = [None] * len(texts)
    if not sung:
        return {"engine": "qwen-align", "times": times, "heard": 0, "language": lang}

    # rough time of every sung line, used only to cut long songs into windows
    rough = {i: fixed[i] for i in sung if i in fixed}
    heard_rough = set(rough)
    if heard_words is not None:
        lines = [{"text": texts[i], "start": fixed.get(i), "end": None} for i in sung]
        res = align_lyrics(lines, [{"words": heard_words}], dur)
        for k, i in enumerate(sung):
            ln = res["lines"][k]
            if ln.get("start") is not None and i not in rough:
                rough[i] = float(ln["start"])
                if ln.get("heard"):
                    heard_rough.add(i)

    # Split long songs into pieces of consecutive sung lines (positions in `sung`),
    # cutting at lines Qwen clearly heard. Each piece is aligned together with a few
    # lines of context on both sides, and only its own lines' times are kept, so the
    # rough cut times never decide where a line lands.
    CONTEXT = 4
    pieces, a, ws = [], 0, 0.0
    for b in range(1, len(sung) + 1):
        if b == len(sung):
            pieces.append((a, b))
            break
        t = rough.get(sung[b])
        if t is None or t - ws <= ALIGN_WINDOW - 25:  # leave room for the context lines
            continue
        cut = next((c for c in range(b, a, -1) if sung[c] in heard_rough and rough[sung[c]] - ws >= 30), b)
        pieces.append((a, cut))
        a, ws = cut, rough[sung[cut]]

    def rough_at(pos, default):
        return rough.get(sung[pos], default) if 0 <= pos < len(sung) else default

    for a, b in pieces:
        if a >= b:
            continue
        lo, hi = max(0, a - CONTEXT), min(len(sung), b + CONTEXT)
        w0 = 0.0 if lo == 0 else max(0.0, rough_at(lo, 0.0) - 1.5)
        w1 = dur if hi == len(sung) else min(dur, rough_at(hi, dur) + 1.0)
        if w1 - w0 > 179.0:  # never more than the aligner takes
            w1 = w0 + 179.0
        chunk = wav[int(w0 * sr):int(w1 * sr)]
        idx = sung[lo:hi]
        res = aligner.align(audio=(chunk, sr), text=" ".join(texts[i] for i in idx), language=lang)[0]
        items, k = list(res.items), 0
        for pos, i in enumerate(idx, start=lo):
            n = len(words_of(texts[i]))
            its = items[k:k + n]
            k += n
            if its and a <= pos < b:
                times[i] = [round(w0 + float(its[0].start_time), 3), round(w0 + float(its[-1].end_time), 3)]
    # the user's own times always win; keep starts moving forward
    for i, t in fixed.items():
        if 0 <= i < len(times):
            times[i] = [t, None]
    last = 0.0
    for i in sung:
        if times[i] is None:
            continue
        if i not in fixed and times[i][0] < last:
            times[i][0] = last
        if times[i][1] is not None and times[i][1] < times[i][0]:
            times[i][1] = times[i][0]
        last = times[i][0]
    return {"engine": "qwen-align", "times": times, "language": lang,
            "heard": sum(1 for i in sung if times[i] and i not in fixed)}


def build_segments(text: str, items):
    """Turn the aligner's bare words (no punctuation) into transcript segments.

    The aligner splits the same text Qwen wrote, so its words appear in the text in
    order. We walk the text letter by letter (not by spaces), because:
      - Qwen glues its 180 s chunks together with no space ("night.Then"),
      - Chinese/Japanese have no spaces and Korean words split mid-word.
    Each timed word gets its own letters plus the punctuation touching it; a word
    that wasn't preceded by a space is marked "j" (join: no space before it), so
    CJK captions and segment text don't get spaces between characters.
    """
    # normalized text with a map back to positions in the original text
    nt, back = [], []
    for i, ch in enumerate(text):
        for c in _norm(ch):
            nt.append(c)
            back.append(i)
    nt = "".join(nt)
    words, ncur, prev_end = [], 0, 0
    for w, s, e in items:
        nw = _norm(w)
        k = nt.find(nw, ncur, ncur + len(nw) + 60) if nw else -1
        if k < 0:  # aligner word not found in the text: show it as it is
            words.append({"w": w, "s": round(s, 3), "e": round(max(e, s), 3)})
            continue
        start, end = back[k], back[k + len(nw) - 1] + 1
        ncur = k + len(nw)
        gap = text[prev_end:start]
        # stand-alone symbols between words ("—", "&") stay with the previous word
        head, _, touching = gap.rpartition(" ") if " " in gap.replace("\n", " ") else ("", "", gap)
        loose = " ".join(x for x in head.replace("\n", " ").split() if x)
        if loose and words:
            words[-1]["w"] += " " + loose
        prefix = "".join(ch for ch in touching if not ch.isspace())
        if prefix and not all(ch in _OPENERS for ch in prefix) and words:
            words[-1]["w"] += prefix  # closing punctuation glued to the previous word
            prefix = ""
        # trailing punctuation that touches the word (up to the next space or letter)
        while end < len(text) and not text[end].isspace() and not _is_wordy(text[end]):
            end += 1
        shown = prefix + text[start:end]
        word = {"w": shown, "s": round(s, 3), "e": round(max(e, s), 3)}
        spaced = any(ch.isspace() for ch in gap)
        prev_ch = text[prev_end - 1] if prev_end else ""
        if words and not spaced and (_CJK.match(text[start]) or (prev_ch and _CJK.match(prev_ch))):
            word["j"] = True  # CJK / Hangul piece: no space before it
        words.append(word)
        prev_end = end
    # keep times moving forward (the aligner can repeat or invert a stamp)
    for a, b in zip(words, words[1:]):
        if b["s"] < a["s"]:
            b["s"] = a["s"]
        if b["e"] < b["s"]:
            b["e"] = b["s"]
    segments, cur = [], []

    def joined(ws):
        return "".join((w["w"] if (i == 0 or w.get("j")) else " " + w["w"]) for i, w in enumerate(ws))

    def flush():
        if cur:
            segments.append({"start": cur[0]["s"], "end": max(cur[-1]["e"], cur[0]["s"] + 0.2),
                             "text": joined(cur), "words": list(cur)})
            cur.clear()

    for wd in words:
        if cur and (wd["s"] - cur[-1]["e"] > 1.2 or len(cur) >= 16 or len(joined(cur)) > 90):
            flush()
        cur.append(wd)
        if re.search(r"[.!?。！？؟][\"'”’»)\]]*$", wd["w"]):
            flush()
    flush()
    return segments


if __name__ == "__main__":
    sys.exit(main())
