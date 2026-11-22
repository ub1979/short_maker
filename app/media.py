"""ffmpeg helpers: probing, browser proxy, and the final vertical render.

This ffmpeg build has no drawtext/subtitles/libass, so every piece of text, logo
and decoration arrives as a PNG drawn by the browser (same code as the live
preview). ffmpeg only composites: base (blur or black) -> under.png -> video
(optionally rounded via mask.png) -> over.png -> timed caption PNGs.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

W, H = 1080, 1920
BROWSER_OK_VIDEO = {"h264", "vp8", "vp9", "av1"}
BROWSER_OK_AUDIO = {"aac", "mp3", "opus", "vorbis", None}


def probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        capture_output=True, text=True, timeout=60,
    )
    if out.returncode != 0:
        raise ValueError("This file is not a readable video.")
    info = json.loads(out.stdout)
    video = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
    audio = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), None)
    if not video:
        raise ValueError("No video stream found in this file.")
    rate = video.get("avg_frame_rate") or "30/1"
    try:
        num, den = rate.split("/")
        fps = float(num) / float(den) if float(den) else 30.0
    except (ValueError, ZeroDivisionError):
        fps = 30.0
    width, height = int(video.get("width", 0)), int(video.get("height", 0))
    rotation = 0
    for side in video.get("side_data_list", []) or []:
        if "rotation" in side:
            rotation = abs(int(side["rotation"])) % 180
    if rotation == 90:
        width, height = height, width
    return {
        "duration": float(info.get("format", {}).get("duration") or video.get("duration") or 0),
        "width": width,
        "height": height,
        "fps": round(fps, 3) if 1 < fps < 240 else 30.0,
        "vcodec": video.get("codec_name"),
        "acodec": audio.get("codec_name") if audio else None,
        "pix_fmt": video.get("pix_fmt"),
        "has_audio": audio is not None,
        "container": info.get("format", {}).get("format_name", ""),
    }


def needs_proxy(meta: dict) -> bool:
    container_ok = any(c in meta["container"] for c in ("mp4", "mov", "webm"))
    eight_bit = meta.get("pix_fmt") in (None, "yuv420p", "yuvj420p")
    return not (container_ok and meta["vcodec"] in BROWSER_OK_VIDEO and meta["acodec"] in BROWSER_OK_AUDIO and eight_bit)


def make_proxy(src: Path, dst: Path, duration: float, on_progress=None) -> None:
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-vf", "scale=-2:'min(720,ih)'",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-progress", "pipe:1", str(dst)]
    _run_with_progress(cmd, duration, on_progress)


def _run_with_progress(cmd: list[str], duration: float, on_progress) -> None:
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    for line in proc.stdout:
        if line.startswith("out_time_us=") and on_progress and duration > 0:
            try:
                on_progress(min(0.99, int(line.split("=")[1]) / 1e6 / duration))
            except ValueError:
                pass
    err = proc.stderr.read()
    if proc.wait() != 0:
        raise RuntimeError("ffmpeg failed: " + err.strip()[-600:])


def render_short(src: Path, out: Path, layers: Path, layout: dict, meta: dict, on_progress=None) -> None:
    start = max(0.0, float(layout["start"]))
    dur = max(0.5, float(layout["end"]) - start)
    fps = 30
    v = layout["video"]
    vx, vy, vw, vh = (int(round(v[k])) for k in ("x", "y", "w", "h"))
    vw += vw % 2
    vh += vh % 2

    inputs = ["-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(src)]
    idx = 1

    def add_png(path: Path, loop: bool = True) -> int:
        nonlocal idx
        if loop:
            inputs.extend(["-loop", "1", "-framerate", str(fps), "-t", f"{dur:.3f}", "-i", str(path)])
        else:  # single frame; overlay repeats the last frame and `enable` gates it (much cheaper)
            inputs.extend(["-i", str(path)])
        idx += 1
        return idx - 1

    filters = []
    if layout.get("bg") == "blur":
        blur = layout.get("blur", {})
        sigma = float(blur.get("sigma", 14))
        bright = float(blur.get("brightness", -0.12))
        filters.append("[0:v]split=2[src][bsrc]")
        filters.append(
            f"[bsrc]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
            f"scale={W // 4}:{H // 4},gblur=sigma={sigma:.2f},scale={W}:{H},"
            f"eq=brightness={bright:.3f}:saturation=1.15,setsar=1,fps={fps}[base]"
        )
    else:
        filters.append("[0:v]null[src]")
        filters.append(f"color=c=black:s={W}x{H}:r={fps}:d={dur:.3f}[base]")
    last = "base"

    under = layers / "under.png"
    if under.exists():
        i = add_png(under)
        filters.append(f"[{last}][{i}:v]overlay=0:0:shortest=1[u]")
        last = "u"

    filters.append(f"[src]scale={vw}:{vh},setsar=1,fps={fps},format=yuva420p[vid0]")
    vid = "vid0"
    mask = layers / "mask.png"
    if mask.exists():
        i = add_png(mask)
        filters.append(f"[{i}:v]scale={vw}:{vh},format=gray[m]")
        filters.append(f"[{vid}][m]alphamerge[vid1]")
        vid = "vid1"
    filters.append(f"[{last}][{vid}]overlay={vx}:{vy}:shortest=1[v]")
    last = "v"

    over = layers / "over.png"
    if over.exists():
        i = add_png(over)
        filters.append(f"[{last}][{i}:v]overlay=0:0:shortest=1[o]")
        last = "o"

    for n, cap in enumerate(layout.get("captions", [])):
        path = layers / f"cap_{n}.png"
        if not path.exists():
            continue
        a, b = max(0.0, float(cap["start"])), min(dur, float(cap["end"]))
        if b <= a:
            continue
        i = add_png(path, loop=False)
        filters.append(
            f"[{last}][{i}:v]overlay={int(cap['x'])}:{int(cap['y'])}:enable='between(t,{a:.3f},{b:.3f})'[c{n}]"
        )
        last = f"c{n}"

    filters.append(f"[{last}]format=yuv420p[out]")
    (layers / "filter.txt").write_text(";\n".join(filters))
    cmd = ["ffmpeg", "-y", "-loglevel", "error", *inputs,
           "-/filter_complex", str(layers / "filter.txt"),
           "-map", "[out]"]
    if meta.get("has_audio"):
        cmd += ["-map", "0:a:0", "-c:a", "aac", "-b:a", "192k"]
    cmd += ["-c:v", "libx264", "-preset", "fast", "-crf", "19", "-profile:v", "high",
            "-r", str(fps), "-t", f"{dur:.3f}", "-movflags", "+faststart",
            "-progress", "pipe:1", str(out)]
    _run_with_progress(cmd, dur, on_progress)
