"""Short Maker HTTP server (FastAPI). Run with ./start.sh"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import ai, media, store

WEB = store.ROOT / "web"
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
MAX_CLIP = 180.0

app = FastAPI(title="Short Maker")
render_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="render")
work_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="work")


@app.exception_handler(ValueError)
async def value_error(_, exc: ValueError):
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.exception_handler(KeyError)
async def key_error(_, exc: KeyError):
    return JSONResponse({"detail": "Not found"}, status_code=404)


def _project(pid: str) -> dict:
    project = store.load_project(pid)
    if not project:
        raise HTTPException(404, "Project not found")
    if any("num" not in c for c in project.get("clips", [])):
        project = store.update_project(pid, _number_clips) or store.load_project(pid)
    return project


def _number_clips(p: dict) -> dict:
    """Give every short a permanent number (#1, #2...). It never changes when other
    shorts are deleted, so the file name video_r_<num> always means the same short."""
    n = max((c.get("num", 0) for c in p.get("clips", [])), default=0)
    for c in p.get("clips", []):
        if "num" not in c:
            n += 1
            c["num"] = n
    return p


async def _save_upload(upload: UploadFile, dst: Path) -> None:
    with dst.open("wb") as f:
        while chunk := await upload.read(4 * 1024 * 1024):
            f.write(chunk)


def _safe_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._ -]", "", name)[:80].strip() or "video"


# ---------------- pages & files ----------------

@app.get("/")
def index():
    return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-store"})


@app.middleware("http")
async def _no_stale_static(request, call_next):
    resp = await call_next(request)
    if request.url.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"  # revalidate so edits show up
    return resp


app.mount("/static", StaticFiles(directory=WEB), name="static")


@app.get("/assets/{name}")
def asset(name: str):
    path = store.ASSETS / Path(name).name
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path)


@app.get("/media/{pid}/{kind}")
def media_file(pid: str, kind: str):
    project = _project(pid)
    folder = store.project_dir(pid)
    if kind == "play":
        name = project.get("proxy") or project["source"]["file"]
    elif kind == "source":
        name = project["source"]["file"]
    else:
        raise HTTPException(404)
    path = folder / name
    if not path.is_file():
        raise HTTPException(404, "Video is still being prepared")
    return FileResponse(path)  # Starlette serves Range requests for scrubbing


@app.get("/media/{pid}/render/{cid}")
def render_file(pid: str, cid: str, download: int = 0):
    """The finished video of one short, wherever the user chose to save it."""
    try:
        r = store.find_clip(_project(pid), cid).get("render") or {}
    except KeyError:
        raise HTTPException(404) from None
    path = Path(r["path"]) if r.get("path") else store.project_dir(pid) / "renders" / Path(r.get("file") or "x").name
    if not path.is_file():
        raise HTTPException(404, "The video file was moved or deleted.")
    return FileResponse(path, filename=path.name if download else None)


# ---------------- where renders are saved ----------------

def _choose_folder(start: str) -> str | None:
    """Native macOS folder picker (this server runs on the user's Mac)."""
    script = ['-e', 'activate',
              '-e', f'set f to choose folder with prompt "Where should Short Maker save the videos?" '
                    f'default location (POSIX file "{start}")',
              '-e', 'POSIX path of f']
    r = subprocess.run(["osascript", *script], capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        return None  # cancelled
    return r.stdout.strip().rstrip("/") or None


@app.post("/api/projects/{pid}/output-dir")
async def set_output_dir(pid: str, request: Request):
    """{"choose": true} opens a Finder folder picker; {"dir": "/path"} sets it directly."""
    body = await request.json()
    project = _project(pid)
    if body.get("choose"):
        settings = store.load_settings()
        start = project.get("output_dir") or settings.get("last_output_dir") or str(Path.home() / "Movies")
        if not Path(start).is_dir():
            start = str(Path.home())
        import asyncio
        chosen = await asyncio.to_thread(_choose_folder, start.replace('"', ""))
        if not chosen:
            return {"dir": project.get("output_dir"), "cancelled": True}
    else:
        chosen = str(body.get("dir") or "").strip()
    path = Path(chosen).expanduser()
    if not path.is_dir():
        raise HTTPException(400, "That folder doesn't exist.")
    if not os.access(path, os.W_OK):
        raise HTTPException(400, "Short Maker can't write to that folder.")
    store.update_project(pid, lambda p: p.update(output_dir=str(path)))
    settings = store.load_settings()
    settings["last_output_dir"] = str(path)
    store.save_settings(settings)
    return {"dir": str(path)}


@app.post("/api/projects/{pid}/output-dir/open")
def open_output_dir(pid: str):
    d = _project(pid).get("output_dir")
    if not d or not Path(d).is_dir():
        raise HTTPException(400, "No save folder chosen yet.")
    subprocess.Popen(["open", d])
    return {"ok": True}


# ---------------- health ----------------

@app.get("/api/health")
def health():
    try:
        import importlib.util
        whisper = importlib.util.find_spec("mlx_whisper") is not None
    except ImportError:
        whisper = False
    return {"ffmpeg": bool(shutil.which("ffmpeg")), "whisper": whisper, "qwen": _qwen_installed()}


# ---------------- projects ----------------

@app.get("/api/projects")
def projects():
    return [{k: p.get(k) for k in ("id", "name", "created", "source", "status")} | {"clips": len(p.get("clips", []))}
            for p in store.list_projects()]


@app.post("/api/projects")
async def create_project(file: UploadFile):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in VIDEO_EXT:
        raise HTTPException(400, f"Unsupported file type {ext or '(none)'}. Use mp4, mov, mkv, webm.")
    pid = store.new_id()
    folder = store.project_dir(pid)
    folder.mkdir(parents=True)
    src = folder / f"source{ext}"
    await _save_upload(file, src)
    try:
        meta = media.probe(src)
    except ValueError:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    project = {
        "id": pid, "name": Path(_safe_name(file.filename or "video")).stem, "created": time.time(),
        "source": {"file": src.name, **meta}, "proxy": None,
        "status": {"proxy": "none", "proxy_progress": 0},
        "transcript": {"status": "none"}, "clips": [],
    }
    if media.needs_proxy(meta):
        project["status"]["proxy"] = "working"
    store.save_project(project)  # save before the worker reads it
    if project["status"]["proxy"] == "working":
        work_pool.submit(_proxy_job, pid)
    return project


def _proxy_job(pid: str) -> None:
    project = store.load_project(pid)
    folder = store.project_dir(pid)
    try:
        def prog(p):
            store.update_project(pid, lambda pr: pr["status"].update(proxy_progress=round(p, 3)))
        media.make_proxy(folder / project["source"]["file"], folder / "proxy.mp4", project["source"]["duration"], prog)
        store.update_project(pid, lambda pr: (pr.update(proxy="proxy.mp4"), pr["status"].update(proxy="done", proxy_progress=1)))
    except Exception as e:  # noqa: BLE001 - surface any failure to the UI
        store.update_project(pid, lambda pr: pr["status"].update(proxy="error", proxy_error=str(e)[:400]))


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    p = _project(pid)
    if (p.get("lyrics_sync") or {}).get("status") == "working" and pid not in _autosync_running:
        p["lyrics_sync"] = {"status": "error", "error": "Auto-sync was interrupted. Press it again."}
    return p


@app.patch("/api/projects/{pid}")
async def patch_project(pid: str, request: Request):
    body = await request.json()
    def fn(p):
        if "name" in body:
            p["name"] = str(body["name"])[:120]
        return p
    return store.update_project(pid, fn)


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    _project(pid)
    shutil.rmtree(store.project_dir(pid), ignore_errors=True)
    return {"ok": True}


# ---------------- transcription ----------------

def _qwen_installed() -> bool:
    import importlib.util
    try:
        return importlib.util.find_spec("qwen_asr") is not None
    except (ImportError, ValueError):
        return False


def _has_urdu_lyrics(project: dict) -> bool:
    from app.lyrics_align import is_rtl_text
    return any(is_rtl_text(l.get("text", "")) for l in (project.get("lyrics") or {}).get("lines", []))


def _pick_asr_model(project: dict, engine: str) -> tuple[str, str]:
    """(model, why). engine: auto | qwen | whisper."""
    settings = store.load_settings()
    whisper = settings.get("whisper_model") or store.DEFAULT_SETTINGS["whisper_model"]
    default = settings.get("asr_model") or store.DEFAULT_SETTINGS["asr_model"]
    qwen = default if default.lower().startswith("qwen/") else store.DEFAULT_SETTINGS["asr_model"]
    if engine == "whisper":
        return whisper, "you picked it for this video"
    if engine == "qwen":
        return (qwen, "you picked it for this video") if _qwen_installed() else (whisper, "Qwen isn't installed")
    if not default.lower().startswith("qwen/"):
        return default, "it's the engine set in AI & settings"
    if _has_urdu_lyrics(project):
        return whisper, "your lyrics are Urdu, which Qwen can't transcribe"
    if str((project.get("transcript") or {}).get("language") or "").lower() in ("ur", "urdu"):
        return whisper, "this video was transcribed as Urdu before, which Qwen can't do"
    if not _qwen_installed():
        return whisper, "Qwen isn't installed"
    return default, "it's the engine set in AI & settings"


@app.post("/api/projects/{pid}/transcribe")
async def transcribe(pid: str, request: Request):
    try:
        body = await request.json()
    except ValueError:
        body = {}
    engine = body.get("engine") if isinstance(body, dict) and body.get("engine") in ("auto", "qwen", "whisper") else "auto"
    project = _project(pid)
    if project["transcript"].get("status") == "working":
        return project["transcript"]
    if not project["source"].get("has_audio"):
        raise HTTPException(400, "This video has no audio to transcribe.")
    model, why = _pick_asr_model(project, engine)
    store.update_project(pid, lambda p: p.update(transcript={"status": "working", "started": time.time(), "model": model, "why": why}))
    work_pool.submit(_transcribe_job, pid, model, why, engine == "auto")
    return {"status": "working", "model": model, "why": why}


def _run_asr(src: Path, out: Path, model: str) -> dict:
    r = subprocess.run([sys.executable, "-m", "app.transcribe_worker", str(src), str(out), model],
                       cwd=store.ROOT, capture_output=True, text=True, timeout=6 * 3600)
    if r.returncode != 0:
        tail = [l for l in r.stderr.strip().splitlines() if l.strip()][-1:] or ["unknown error"]
        raise RuntimeError(tail[0][:300])
    return json.loads(out.read_text())


def _transcribe_job(pid: str, model: str, why: str = "", auto: bool = False) -> None:
    project = store.load_project(pid)
    folder = store.project_dir(pid)
    out = folder / "transcript.json"
    src = folder / project["source"]["file"]
    try:
        data = _run_asr(src, out, model)
        # Qwen has no Urdu and hears Urdu speech as Hindi. In Auto mode, redo it with
        # Whisper, which knows both (and writes Urdu in Urdu script).
        if auto and data.get("engine") == "qwen" and data.get("language") in ("hindi", "urdu"):
            store.update_project(pid, lambda p: p["transcript"].update(
                why="Qwen heard Hindi/Urdu, so it's being redone with Whisper, which knows Urdu"))
            model = store.load_settings().get("whisper_model") or store.DEFAULT_SETTINGS["whisper_model"]
            why = "Qwen heard Hindi/Urdu, and Whisper also knows Urdu"
            data = _run_asr(src, out, model)
        store.update_project(pid, lambda p: p.update(transcript={"status": "done", "model": model, "why": why, **data}))
    except Exception as e:  # noqa: BLE001
        store.update_project(pid, lambda p: p.update(transcript={"status": "error", "error": f"Transcription failed: {e}"}))


@app.put("/api/projects/{pid}/transcript/words")
async def edit_words(pid: str, request: Request):
    """Replace the words between two source times (one caption chunk) with new text.

    Fixes the transcript itself, so the correction shows in every short, the
    transcript panel and what the AI reads. Word timings are kept when the word
    count is unchanged, otherwise spread over the original span by word length.
    """
    body = await request.json()
    s0, e0, text = float(body["start"]), float(body["end"]), str(body.get("text", ""))[:500]

    def fn(p):
        tr = p.get("transcript") or {}
        for seg in tr.get("segments", []):
            idx = [i for i, w in enumerate(seg["words"]) if w["s"] >= s0 - 0.002 and w["e"] <= e0 + 0.002]
            if not idx:
                continue
            i, j = idx[0], idx[-1]
            old = seg["words"][i:j + 1]
            new = text.split()
            if len(new) == len(old):
                repl = [{**w, "w": n} for w, n in zip(old, new)]
            else:
                a, b = old[0]["s"], old[-1]["e"]
                total = sum(len(n) + 1 for n in new) or 1
                repl, t = [], a
                for n in new:
                    d = (b - a) * (len(n) + 1) / total
                    repl.append({"w": n, "s": round(t, 3), "e": round(t + d, 3)})
                    t += d
            seg["words"][i:j + 1] = repl
            seg["text"] = " ".join(w["w"] for w in seg["words"])
            seg["edited"] = True
            return seg
        raise ValueError("Those caption words were not found. Reload and try again.")

    return store.update_project(pid, fn)


@app.put("/api/projects/{pid}/lyrics")
async def put_lyrics(pid: str, request: Request):
    """Your own lyrics/caption lines. start/end are source-video seconds (null = not synced yet)."""
    body = await request.json()
    lines = body.get("lines")
    if not isinstance(lines, list) or len(lines) > 3000:
        raise HTTPException(400, "lines must be a list (max 3000)")

    def num(v, dur):
        try:
            v = float(v)
        except (TypeError, ValueError):
            return None
        return round(min(max(v, 0.0), dur), 3) if v == v else None

    def fn(p):
        dur = p["source"]["duration"]
        clean = []
        for line in lines:
            if not isinstance(line, dict):
                continue
            text = str(line.get("text", "")).replace("\n", " ").strip()[:300]
            if not text:
                continue
            item = {"text": text, "start": num(line.get("start"), dur), "end": num(line.get("end"), dur)}
            if item["start"] is not None:
                for flag in ("est", "heard"):  # est = guessed by auto-sync (greyed); heard = timed from audio
                    if line.get(flag) is True:
                        item[flag] = True
            clean.append(item)
        p["lyrics"] = {"lines": clean, "updated": time.time()}
        return p["lyrics"]
    return store.update_project(pid, fn)


@app.post("/api/projects/{pid}/lyrics/autosync")
def lyrics_autosync(pid: str):
    """Time the user's lyric lines from the audio: Whisper (primed with the lyrics) + alignment."""
    project = _project(pid)
    if pid in _autosync_running:  # a stale "working" left by a server restart doesn't block
        return project.get("lyrics_sync") or {"status": "working"}
    if not project["source"].get("has_audio"):
        raise HTTPException(400, "This video has no audio.")
    if not (project.get("lyrics") or {}).get("lines"):
        raise HTTPException(400, "Add your lyrics first.")
    store.update_project(pid, lambda p: p.update(lyrics_sync={"status": "working", "started": time.time()}))
    _autosync_running.add(pid)
    work_pool.submit(_autosync_job, pid)
    return {"status": "working"}


_autosync_running: set[str] = set()


def _autosync_job(pid: str) -> None:
    try:
        _autosync(pid)
    finally:
        _autosync_running.discard(pid)


def _autosync(pid: str) -> None:
    from app.lyrics_align import align_lyrics
    project = store.load_project(pid)
    folder = store.project_dir(pid)
    model = store.load_settings().get("whisper_model") or store.DEFAULT_SETTINGS["whisper_model"]
    try:
        # Whisper picks ONE language per run, so a song mixing Urdu and English gets one
        # pass per language, each primed with that language's lines. Words from all
        # passes are merged by time; the aligner just picks whichever matches.
        from app.lyrics_align import is_rtl_text
        texts = list(dict.fromkeys(l["text"] for l in project["lyrics"]["lines"]))
        rtl = [t for t in texts if is_rtl_text(t)]
        ltr = [t for t in texts if not is_rtl_text(t)]
        passes = []
        if rtl:
            passes.append(("ur", rtl))
        if ltr:
            passes.append(("en" if rtl else None, ltr))
        words = []
        for lang, lines in passes:
            out, opt = folder / f"lyrics_asr_{lang or 'auto'}.json", folder / "lyrics_asr_opts.json"
            # Whisper only reads ~220 tokens of prompt; a few lines set the script and style.
            opt.write_text(json.dumps({"language": lang, "prompt": " ".join(lines)[:300]}))
            r = subprocess.run([sys.executable, "-m", "app.transcribe_worker", str(folder / project["source"]["file"]),
                                str(out), model, str(opt)],
                               cwd=store.ROOT, capture_output=True, text=True, timeout=6 * 3600)
            if r.returncode != 0:
                tail = [l for l in r.stderr.strip().splitlines() if l.strip()][-1:] or ["unknown error"]
                raise RuntimeError(tail[0][:300])
            for seg in json.loads(out.read_text()).get("segments", []):
                words.extend(seg.get("words", []))
        words.sort(key=lambda w: w["s"])
        segments = [{"words": words}]

        def fn(p):
            lines = (p.get("lyrics") or {}).get("lines") or []
            res = align_lyrics(lines, segments, p["source"]["duration"])
            if not res["heard"] and not res["kept"]:
                p["lyrics_sync"] = {"status": "error", "error": "Couldn't hear any of your lines in the audio. Try Tap to sync, or a bigger Whisper model in AI & settings."}
                return
            p["lyrics"] = {"lines": res["lines"], "updated": time.time()}
            p["lyrics_sync"] = {"status": "done", "heard": res["heard"], "estimated": res["estimated"],
                                "kept": res["kept"], "total": len(lines), "finished": time.time()}
        store.update_project(pid, fn)
    except Exception as e:  # noqa: BLE001
        store.update_project(pid, lambda p: p.update(lyrics_sync={"status": "error", "error": f"Auto-sync failed: {e}"}))


# ---------------- clips ----------------

CLIP_FIELDS = {"start", "end", "title", "template_id", "captions", "caption_source", "copy", "overrides"}


def _clean_clip(clip: dict, duration: float) -> dict:
    start = max(0.0, min(float(clip.get("start", 0)), duration))
    end = max(0.0, min(float(clip.get("end", start + 30)), duration))
    if end - start < 1:
        raise ValueError("A short must be at least 1 second long.")
    if end - start > MAX_CLIP:
        end = start + MAX_CLIP
    clip["start"], clip["end"] = round(start, 3), round(end, 3)
    clip["title"] = str(clip.get("title", ""))[:200]
    if clip.get("caption_source") not in (None, "transcript", "lyrics"):
        clip["caption_source"] = "transcript"
    return clip


@app.post("/api/projects/{pid}/clips")
async def add_clip(pid: str, request: Request):
    body = await request.json()
    def fn(p):
        clip = {"id": store.new_id(), "title": "", "template_id": "midnight", "captions": True,
                "copy": {}, "overrides": {}, "render": {"status": "none"}}
        clip.update({k: v for k, v in body.items() if k in CLIP_FIELDS})
        _clean_clip(clip, p["source"]["duration"])
        p["clips"].append(clip)
        _number_clips(p)
        return clip
    return store.update_project(pid, fn)


@app.patch("/api/projects/{pid}/clips/{cid}")
async def patch_clip(pid: str, cid: str, request: Request):
    body = await request.json()
    def fn(p):
        clip = store.find_clip(p, cid)
        for k, v in body.items():
            if k == "copy" and isinstance(v, dict):
                for platform, fields in v.items():
                    if platform in ("youtube", "instagram", "tiktok") and isinstance(fields, dict):
                        clip.setdefault("copy", {}).setdefault(platform, {}).update(
                            {f: str(x)[:5000] for f, x in fields.items() if f in ("title", "description", "hashtags")})
            elif k in CLIP_FIELDS:
                clip[k] = v
        _clean_clip(clip, p["source"]["duration"])
        return clip
    return store.update_project(pid, fn)


@app.delete("/api/projects/{pid}/clips/{cid}")
def delete_clip(pid: str, cid: str):
    def fn(p):
        p["clips"] = [c for c in p["clips"] if c["id"] != cid]
    store.update_project(pid, fn)
    return {"ok": True}


@app.post("/api/projects/{pid}/clips/{cid}/render")
async def render_clip(pid: str, cid: str, request: Request):
    project = _project(pid)
    clip = store.find_clip(project, cid)
    form = await request.form()
    layout = json.loads(form["layout"])
    layout["start"], layout["end"] = clip["start"], clip["end"]
    job = store.new_id()
    layers = store.project_dir(pid) / "jobs" / job
    layers.mkdir(parents=True)
    for key, value in form.multi_items():
        if key == "layout" or not hasattr(value, "read"):
            continue
        if re.fullmatch(r"under|over|mask|cap_\d{1,4}", key):
            (layers / f"{key}.png").write_bytes(await value.read())
    out_dir = Path(project.get("output_dir") or "")
    if not project.get("output_dir") or not out_dir.is_dir():
        raise HTTPException(400, "Choose where to save the videos first.")
    if "num" not in clip:
        project = store.update_project(pid, _number_clips) or store.load_project(pid)
        clip = store.find_clip(project, cid)
    # "<video name>_r_<short number>.mp4"; rendering the same short again replaces its file
    base = re.sub(r'[/\\:*?"<>|]+', " ", project["name"]).strip(" .")[:80] or "video"
    out_name = f"{base}_r_{clip['num']}.mp4"
    def fn(p):
        store.find_clip(p, cid)["render"] = {"status": "queued", "progress": 0, "job": job, "requested": time.time()}
    store.update_project(pid, fn)
    render_pool.submit(_render_job, pid, cid, job, layout, out_dir / out_name)
    return {"status": "queued", "job": job}


def _render_job(pid: str, cid: str, job: str, layout: dict, out: Path) -> None:
    folder = store.project_dir(pid)
    layers = folder / "jobs" / job
    project = store.load_project(pid)

    def set_render(**kw):
        def fn(p):
            try:
                clip = store.find_clip(p, cid)
            except KeyError:
                return
            if clip.get("render", {}).get("job") == job:
                clip["render"].update(kw)
        store.update_project(pid, fn)

    try:
        set_render(status="rendering", progress=0)
        tmp = out.with_name(f".{out.stem}.rendering.mp4")  # hidden until finished, then renamed
        last = [0.0]
        def prog(x):
            if x - last[0] >= 0.03:
                last[0] = x
                set_render(progress=round(x, 3))
        media.render_short(folder / project["source"]["file"], tmp, layers, layout, project["source"], prog)
        tmp.replace(out)
        set_render(status="done", progress=1, file=out.name, path=str(out), finished=time.time())
        shutil.rmtree(layers, ignore_errors=True)
        try:
            layers.parent.rmdir()  # drop the jobs folder once no render is using it
        except OSError:
            pass
    except Exception as e:  # noqa: BLE001
        set_render(status="error", error=str(e)[:500])
        try:
            out.with_name(f".{out.stem}.rendering.mp4").unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass


# ---------------- templates & assets ----------------

@app.get("/api/templates")
def templates():
    out = [store.read_json(p) for p in sorted(store.TEMPLATES.glob("*.json"))]
    return [t for t in out if t]


@app.post("/api/templates")
async def save_template(request: Request):
    tpl = await request.json()
    if not isinstance(tpl, dict) or not tpl.get("name"):
        raise HTTPException(400, "Template needs a name")
    tid = tpl.get("id") if str(tpl.get("id", "")).startswith("custom-") else f"custom-{store.new_id()}"
    store.check_id(tid)
    tpl.update(id=tid, builtin=False, name=str(tpl["name"])[:60], saved=time.time())
    store.write_json(store.TEMPLATES / f"{tid}.json", tpl)
    return tpl


@app.delete("/api/templates/{tid}")
def delete_template(tid: str):
    store.check_id(tid)
    (store.TEMPLATES / f"{tid}.json").unlink(missing_ok=True)
    return {"ok": True}


@app.post("/api/assets")
async def upload_asset(file: UploadFile):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in IMAGE_EXT:
        raise HTTPException(400, "Use a png, jpg, webp or gif image.")
    name = f"{store.new_id()}{ext}"
    await _save_upload(file, store.ASSETS / name)
    return {"url": f"/assets/{name}"}


# ---------------- brand & settings ----------------

@app.get("/api/brand")
def get_brand():
    return store.load_brand()


@app.put("/api/brand")
async def put_brand(request: Request):
    body = await request.json()
    brand = store.load_brand()
    for k in ("channel", "handle", "logo", "cta"):
        if k in body:
            brand[k] = str(body[k])[:300]
    if isinstance(body.get("links"), list):
        brand["links"] = [str(x)[:200] for x in body["links"]][:4]
    store.save_brand(brand)
    return brand


@app.get("/api/settings")
def get_settings():
    return store.load_settings()


@app.put("/api/settings")
async def put_settings(request: Request):
    body = await request.json()
    settings = store.load_settings()
    if isinstance(body.get("connections"), list):
        conns = []
        for c in body["connections"]:
            if not isinstance(c, dict) or c.get("engine") not in ai.ENGINES:
                continue
            conns.append({k: str(c.get(k, ""))[:300] for k in ("id", "name", "engine", "model", "base_url", "api_key_env", "binary") if c.get(k)})
        settings["connections"] = conns
    for k in ("active_connection", "whisper_model", "asr_model"):
        if k in body:
            settings[k] = str(body[k])[:200]
    store.save_settings(settings)
    return settings


def _connection(cid: str | None, override: dict | None = None) -> dict:
    if override and override.get("engine") in ai.ENGINES:
        return override
    settings = store.load_settings()
    cid = cid or settings.get("active_connection")
    for c in settings.get("connections", []):
        if c.get("id") == cid:
            return c
    raise HTTPException(400, "No AI connection selected. Open Settings to add one.")


@app.post("/api/connections/discover")
async def discover(request: Request):
    body = await request.json()
    return ai.discover(_connection(body.get("id"), body.get("connection")))


@app.post("/api/connections/test")
async def test_conn(request: Request):
    body = await request.json()
    return ai.test(_connection(body.get("id"), body.get("connection")))


@app.post("/api/chat")
async def chat(request: Request):
    body = await request.json()
    project = _project(body["project_id"])
    conn = _connection(None)
    try:
        import asyncio
        return await asyncio.to_thread(ai.chat, conn, project, store.load_brand(), body.get("templates", []),
                                       body.get("selected"), body.get("messages", []),
                                       body.get("design") if isinstance(body.get("design"), dict) else None)
    except ai.AIError as e:
        raise HTTPException(502, str(e)) from None
