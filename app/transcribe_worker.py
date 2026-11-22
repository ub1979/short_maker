"""Run in a subprocess: python -m app.transcribe_worker <media> <out.json> <model>.

Kept out of the server process so a crash or the large model doesn't take the
server down, and memory is released when transcription finishes.
"""
import json
import sys


def main() -> int:
    media, out, model = sys.argv[1], sys.argv[2], sys.argv[3]
    # Optional 4th arg: JSON options for lyrics auto-sync:
    # {"prompt": words to expect, "language": "en"/"ur"/null}. Songs loop easily, so
    # with options we also stop Whisper conditioning on its own previous output.
    opts = {}
    if len(sys.argv) > 4:
        with open(sys.argv[4]) as f:
            o = json.load(f)
        opts = {"initial_prompt": o.get("prompt") or None, "language": o.get("language") or None,
                "condition_on_previous_text": False, "hallucination_silence_threshold": 2.0}
    try:
        import mlx_whisper
    except ImportError:
        print("mlx-whisper is not installed (it needs an Apple Silicon Mac).", file=sys.stderr)
        return 2
    result = mlx_whisper.transcribe(media, path_or_hf_repo=model, word_timestamps=True, **opts)
    segments = []
    for seg in result.get("segments", []):
        words = [
            {"w": w["word"].strip(), "s": round(float(w["start"]), 3), "e": round(float(w["end"]), 3)}
            for w in seg.get("words", []) if w.get("word", "").strip()
        ]
        segments.append({"start": round(float(seg["start"]), 3), "end": round(float(seg["end"]), 3),
                         "text": seg["text"].strip(), "words": words})
    with open(out, "w") as f:
        json.dump({"language": result.get("language"), "segments": segments}, f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
