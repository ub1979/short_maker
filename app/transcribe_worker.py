"""Run in a subprocess: python -m app.transcribe_worker <media> <out.json> <model> [opts.json]

<model> picks the engine:
  - "Qwen/Qwen3-ASR-..."  -> Qwen3-ASR + Qwen3-ForcedAligner (word times). Best for
    English and ~29 other languages, but it has NO Urdu.
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
