"""Small JSON-file storage. Everything lives under ./data so the app is portable."""
from __future__ import annotations

import json
import re
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PROJECTS = DATA / "projects"
TEMPLATES = DATA / "templates"
ASSETS = DATA / "assets"
for d in (PROJECTS, TEMPLATES, ASSETS):
    d.mkdir(parents=True, exist_ok=True)

_lock = threading.RLock()
SAFE_ID = re.compile(r"^[a-z0-9-]{4,64}$")


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def check_id(value: str) -> str:
    if not SAFE_ID.match(value or ""):
        raise ValueError("Invalid id")
    return value


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def write_json(path: Path, data) -> None:
    with _lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1))
        tmp.replace(path)


# ---------- projects ----------

def project_dir(pid: str) -> Path:
    return PROJECTS / check_id(pid)


def load_project(pid: str) -> dict | None:
    return read_json(project_dir(pid) / "project.json")


def save_project(project: dict) -> None:
    project["updated"] = time.time()
    write_json(project_dir(project["id"]) / "project.json", project)


def update_project(pid: str, fn):
    """Read-modify-write under the global lock so worker threads don't clobber edits."""
    with _lock:
        project = load_project(pid)
        if project is None:
            raise KeyError(pid)
        result = fn(project)
        save_project(project)
        return result


def list_projects() -> list[dict]:
    out = []
    for p in PROJECTS.glob("*/project.json"):
        data = read_json(p)
        if data:
            out.append(data)
    out.sort(key=lambda p: p.get("created", 0), reverse=True)
    return out


def find_clip(project: dict, cid: str) -> dict:
    for clip in project.get("clips", []):
        if clip["id"] == cid:
            return clip
    raise KeyError(cid)


# ---------- settings / brand ----------

DEFAULT_SETTINGS = {
    "active_connection": "claude",
    "whisper_model": "mlx-community/whisper-small-mlx",
    "connections": [
        {"id": "claude", "name": "Claude (signed-in Claude Code)", "engine": "claude-cli", "model": "claude-sonnet-5-5"},
        {"id": "codex", "name": "Codex CLI", "engine": "codex", "model": ""},
        {"id": "ollama", "name": "Ollama (local)", "engine": "ollama", "base_url": "http://127.0.0.1:11434", "model": ""},
    ],
}

DEFAULT_BRAND = {"channel": "Your Channel", "handle": "@yourchannel", "logo": "", "links": ["youtube.com/@yourchannel"], "cta": "Full video on the channel"}


def load_settings() -> dict:
    data = read_json(DATA / "settings.json")
    if not data:
        data = json.loads(json.dumps(DEFAULT_SETTINGS))
        write_json(DATA / "settings.json", data)
    return data


def save_settings(data: dict) -> None:
    write_json(DATA / "settings.json", data)


def load_brand() -> dict:
    return {**DEFAULT_BRAND, **(read_json(DATA / "brand.json") or {})}


def save_brand(data: dict) -> None:
    write_json(DATA / "brand.json", data)
