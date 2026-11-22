"""AI connections, same model as Appling/CoB: signed-in CLIs (Claude Code, Codex),
local Ollama, any OpenAI-compatible endpoint, or the Anthropic API.

API keys are never stored: a connection names an environment variable
(api_key_env) that must be set when the server starts.

The chat bot controls the editor through a plain-text protocol that works on
every engine: it replies normally and may add one ```actions [...]``` JSON
block. The browser validates each action before applying it.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import httpx

CLAUDE_MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-2",
                 "sonnet", "opus", "haiku", "default"]
ENGINES = {"claude-cli", "codex", "ollama", "openai-compatible", "anthropic"}


class AIError(Exception):
    pass


def cli_env() -> dict:
    env = dict(os.environ)
    env.pop("CLAUDECODE", None)  # allow running when the server was started from a Claude session
    env["PATH"] = os.pathsep.join([str(Path.home() / ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", env.get("PATH", "")])
    return env


def _which(binary: str) -> str | None:
    return shutil.which(binary, path=cli_env()["PATH"])


def base_url(conn: dict) -> str:
    engine = conn["engine"]
    default = {"ollama": "http://127.0.0.1:11434/v1", "anthropic": "https://api.anthropic.com/v1"}.get(engine, "https://api.openai.com/v1")
    base = (conn.get("base_url") or default).rstrip("/")
    if engine == "ollama" and not base.endswith("/v1"):
        base += "/v1"
    return base


def headers(conn: dict, require_key: bool = False) -> dict:
    engine = conn["engine"]
    if engine == "ollama" and not conn.get("api_key_env"):
        return {}
    name = conn.get("api_key_env") or ("ANTHROPIC_API_KEY" if engine == "anthropic" else "OPENAI_API_KEY")
    key = os.environ.get(name, "")
    if require_key and not key:
        raise AIError(f"{name} is not set. Set it in your shell before running ./start.sh.")
    if engine == "anthropic":
        return {"x-api-key": key, "anthropic-version": "2023-06-01"}
    return {"Authorization": "Bearer " + key} if key else {}


def _http_error(status: int) -> str:
    if status in (401, 403):
        return "The provider rejected the credentials."
    if status == 404:
        return "Endpoint or model not found. Check the base URL and model name."
    if status == 429:
        return "Rate limited or out of quota."
    return f"Provider returned HTTP {status}."


def discover(conn: dict) -> dict:
    engine = conn["engine"]
    try:
        if engine == "claude-cli":
            if not _which(conn.get("binary", "claude")):
                raise AIError("Claude Code is not installed. Install it, then run: claude auth login")
            r = subprocess.run([conn.get("binary", "claude"), "auth", "status", "--json"], env=cli_env(),
                               capture_output=True, text=True, timeout=15, stdin=subprocess.DEVNULL)
            try:
                logged = json.loads(r.stdout).get("loggedIn", False)
            except ValueError:
                logged = False
            msg = "Signed in." if logged else "Not signed in. Run: claude auth login"
            return {"ok": logged, "models": CLAUDE_MODELS, "message": msg}
        if engine == "codex":
            if not _which(conn.get("binary", "codex")):
                raise AIError("Codex CLI is not installed. Install it, then run: codex login")
            return {"ok": True, "models": ["", "gpt-5.5", "gpt-5.5-mini"],
                    "message": "Codex found. Leave model empty to use its default, then press Test."}
        auth = headers(conn, require_key=engine == "anthropic")
        with httpx.Client(timeout=8) as client:
            r = client.get(base_url(conn) + "/models", headers=auth)
        if r.status_code >= 400:
            raise AIError(_http_error(r.status_code))
        names = [m["id"] for m in r.json().get("data", []) if m.get("id")]
        if not names:
            return {"ok": False, "models": [], "message": "Connected, but no models. For Ollama run: ollama pull llama3.2"}
        return {"ok": True, "models": names, "message": f"{len(names)} models found."}
    except AIError as e:
        return {"ok": False, "models": [], "message": str(e)}
    except (httpx.ConnectError, httpx.TimeoutException):
        return {"ok": False, "models": [], "message": "Could not reach the server. Is it running?"}
    except (OSError, subprocess.TimeoutExpired, ValueError) as e:
        return {"ok": False, "models": [], "message": f"Check failed: {type(e).__name__}"}


def test(conn: dict) -> dict:
    t = time.monotonic()
    try:
        text = complete(conn, "Reply with exactly: OK", [{"role": "user", "content": "Say OK."}], timeout=90)
        return {"ok": True, "message": f"Replied: {text.strip()[:40]}", "ms": round((time.monotonic() - t) * 1000)}
    except AIError as e:
        return {"ok": False, "message": str(e), "ms": round((time.monotonic() - t) * 1000)}


def _flatten(messages: list[dict]) -> str:
    """CLIs take one prompt; pass the conversation as a readable transcript."""
    if len(messages) == 1:
        return messages[0]["content"]
    lines = ["Conversation so far:"]
    for m in messages[:-1]:
        lines.append(f"\n[{m['role'].upper()}]\n{m['content']}")
    lines.append(f"\n[USER - reply to this]\n{messages[-1]['content']}")
    return "\n".join(lines)


def complete(conn: dict, system: str, messages: list[dict], timeout: int = 240) -> str:
    engine = conn["engine"]
    if engine not in ENGINES:
        raise AIError("Unknown engine.")
    model = (conn.get("model") or "").strip()
    try:
        if engine == "claude-cli":
            binary = conn.get("binary", "claude")
            if not _which(binary):
                raise AIError("Claude Code is not installed.")
            args = [binary, "--print", _flatten(messages), "--output-format", "json", "--tools", "",
                    "--no-session-persistence", "--system-prompt", system]
            if model and model != "default":
                args += ["--model", model]
            with tempfile.TemporaryDirectory(prefix="shortmaker-") as cwd:
                r = subprocess.run(args, env=cli_env(), cwd=cwd, capture_output=True, text=True,
                                   timeout=timeout, stdin=subprocess.DEVNULL)
            try:
                data = json.loads(r.stdout)
            except ValueError:
                raise AIError("Claude Code returned no answer. Check: claude auth status") from None
            if data.get("is_error"):
                raise AIError("Claude Code error: " + str(data.get("result", ""))[:300])
            return data.get("result", "")
        if engine == "codex":
            binary = conn.get("binary", "codex")
            if not _which(binary):
                raise AIError("Codex CLI is not installed.")
            with tempfile.TemporaryDirectory(prefix="shortmaker-") as cwd:
                out = Path(cwd) / "last.txt"
                args = [binary, "exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only",
                        "--color", "never", "-C", cwd, "-o", str(out)]
                if model:
                    args += ["-m", model]
                args.append(system + "\n\nDo not run commands or read files. Just answer.\n\n" + _flatten(messages))
                r = subprocess.run(args, env=cli_env(), capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
                if r.returncode != 0 or not out.exists():
                    raise AIError("Codex failed. Check: codex login")
                return out.read_text()
        if not model:
            raise AIError("Pick a model for this connection in Settings.")
        anthropic = engine == "anthropic"
        auth = headers(conn, require_key=anthropic)
        if anthropic:
            body = {"model": model, "max_tokens": 4096, "system": system, "messages": messages}
            url = base_url(conn) + "/messages"
        else:
            body = {"model": model, "messages": [{"role": "system", "content": system}, *messages]}
            url = base_url(conn) + "/chat/completions"
        with httpx.Client(timeout=httpx.Timeout(timeout, connect=10)) as client:
            r = client.post(url, headers=auth, json=body)
        if r.status_code >= 400:
            raise AIError(_http_error(r.status_code))
        data = r.json()
        if anthropic:
            return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
        return data["choices"][0]["message"].get("content") or ""
    except subprocess.TimeoutExpired:
        raise AIError("The model took too long to answer.") from None
    except (httpx.ConnectError, httpx.TimeoutException):
        raise AIError("Could not reach the model server.") from None


# ---------------- editor chat ----------------

def _ts(sec: float) -> str:
    m, s = divmod(max(0.0, sec), 60)
    return f"{int(m):02d}:{s:04.1f}"


def transcript_text(project: dict, limit: int = 60000) -> str:
    tr = project.get("transcript") or {}
    segs = tr.get("segments") or []
    if not segs:
        return "(no transcript yet - the user can press Transcribe)"
    lines = [f"[{s['start']:.1f}-{s['end']:.1f}] {s['text']}" for s in segs]
    text = "\n".join(lines)
    if len(text) > limit:
        text = text[:limit] + "\n...(transcript truncated)"
    return text


def lyrics_text(project: dict, limit: int = 30000) -> str:
    lines = (project.get("lyrics") or {}).get("lines") or []
    if not lines:
        return ""
    synced = sum(1 for line in lines if line.get("start") is not None)
    out = [f"USER LYRICS: {len(lines)} lines, {synced} synced to a time. (Their own caption lines; '[--]' = no time yet; a short shows them with caption_source=lyrics.)"]
    for line in lines:
        t = f"{line['start']:.1f}" if line.get("start") is not None else "--"
        out.append(f"[{t}] {line['text']}")
    return "\n".join(out)[:limit] + "\n"


SYSTEM = """You are the assistant inside Short Maker, an app that cuts a long 16:9 video into vertical 9:16 shorts for YouTube Shorts, Instagram Reels and TikTok.
You can change the editor. Talk to the user briefly and in plain language. When you want to change something, end your reply with ONE fenced block:

```actions
[ {{"type": "...", ...}} ]
```

Allowed actions (times are seconds in the SOURCE video, decimals allowed):
- {{"type":"add_clip","start":12.5,"end":48.0,"title":"Hook text","template_id":"optional","caption_source":"transcript|lyrics (optional)"}}
- {{"type":"update_clip","clip_id":"ID","start":..,"end":..,"title":"..","template_id":"..","captions":true,"caption_source":"transcript|lyrics"}}  (only include fields you change)
- {{"type":"delete_clip","clip_id":"ID"}}
- {{"type":"select_clip","clip_id":"ID"}}
- {{"type":"set_copy","clip_id":"ID","platform":"youtube|instagram|tiktok","title":"..","description":"..","hashtags":"#a #b"}}
- {{"type":"render_clip","clip_id":"ID"}}  (only when the user asks to render/export)
- {{"type":"set_design","clip_id":"ID","scope":"clip|all","changes":{{"links.y":1380,"captions.size":64}}}}  change how a short looks. Keys are the paths listed under DESIGN; "scope":"all" applies to every short. Values outside the allowed range are clamped.
- {{"type":"set_brand","channel":"..","handle":"@..","cta":"..","links":["..",".."]}}  change the channel name, handle, call to action or links (max 3) shown on every short. Only include fields you change.

Rules:
- Good shorts are 20-60 seconds, start on a strong hook, and end on a complete thought.
- Timing: you can only place clips using real timestamps. Synced USER LYRICS lines are the best source for songs: start a clip at a line's time and end it at the time of the line after the last one you want (or the video end). Otherwise use transcript timestamps at sentence boundaries. Never guess times from the lyric order or the song length.
- When a clip covers user lyrics, set "caption_source":"lyrics" (add_clip accepts it too).
- If the user lyrics exist but the lines you need have no time and there is no transcript: pick the moments by their words, then tell the user those lines need times first. They open the "My lyrics" tab under the video and press "Tap to sync" (play the song, press Space as each line starts). Once synced, you can set exact clips. Do not tell them to Transcribe in that case.
- If there are no user lyrics and no transcript, say so and suggest pressing Transcribe or adding their lyrics in "My lyrics"; you can still help with titles and templates.
- Titles on the short should be short and punchy (max ~8 words).
- Only use template ids from the list below. Never invent clip ids.
- Never add a short for a moment that already has one (see CLIPS): a new short may share at most 20s with an existing one. To change an existing short, use update_clip on its id instead of adding a copy. The app also refuses duplicates.
- Layout (canvas is 1080x1920; y grows downward): every "*.y" is the CENTRE of that element, except captions.y, which is the centre of the LAST caption line (longer captions stack upward). DESIGN.boxes gives each element's real top/bottom, DESIGN.overlaps lists clashes. Keep a gap of 30px or more between title, channel, captions and links. Platform buttons and captions cover y above ~150 and below ~1500 on TikTok/Reels, so keep text between y 160 and 1490 unless the user insists. When you move something, check the new box against its neighbours (box height stays the same) and say where you put it.
- Placeholder channel details (like "Your Channel", "@yourchannel", "youtube.com/@yourchannel") mean the user hasn't set theirs: ask for their real name/handle/links before inventing any, or offer to hide them (links.show / channel.show false).
- Do not put the actions block anywhere except the very end. Leave it out if nothing should change.

VIDEO: "{name}"  duration {duration}s ({duration_ts})
SELECTED CLIP: {selected}
CLIPS:
{clips}
TEMPLATES:
{templates}
BRAND: {brand}
DESIGN (selected short): {design}
TRANSCRIPT (seconds):
{transcript}
{lyrics}"""

ACTIONS_RE = re.compile(r"```actions\s*(.*?)```", re.S)


def chat(conn: dict, project: dict, brand: dict, templates: list[dict], selected: str | None, messages: list[dict],
         design: dict | None = None) -> dict:
    clips = project.get("clips", [])
    clip_lines = "\n".join(
        f"- id={c['id']} {c['start']:.1f}-{c['end']:.1f}s ({_ts(c['start'])}-{_ts(c['end'])}) title={c.get('title','')!r} template={c.get('template_id')} captions={c.get('captions', True)}"
        for c in clips) or "(none yet)"
    tpl_lines = "\n".join(f"- {t.get('id')}: {t.get('name')} ({t.get('look','')})" for t in templates[:60])
    system = SYSTEM.format(
        name=project.get("name", ""), duration=round(project["source"]["duration"], 1),
        duration_ts=_ts(project["source"]["duration"]), selected=selected or "none", clips=clip_lines,
        templates=tpl_lines, brand=json.dumps({k: brand.get(k) for k in ("channel", "handle", "links", "cta")}),
        transcript=transcript_text(project, 200000 if conn['engine'] in ('claude-cli', 'codex', 'anthropic') else 40000),
        lyrics=lyrics_text(project),
        design=json.dumps(design, ensure_ascii=False)[:6000] if design else "(no short selected)")
    msgs = [{"role": m["role"], "content": str(m["content"])[:8000]} for m in messages[-16:] if m.get("role") in ("user", "assistant")]
    if not msgs or msgs[-1]["role"] != "user":
        raise AIError("Nothing to answer.")
    raw = complete(conn, system, msgs)
    actions, reply = [], raw
    match = ACTIONS_RE.search(raw)
    if match:
        reply = (raw[:match.start()] + raw[match.end():]).strip()
        try:
            parsed = json.loads(match.group(1))
            actions = parsed if isinstance(parsed, list) else [parsed]
            actions = [a for a in actions if isinstance(a, dict) and isinstance(a.get("type"), str)]
        except ValueError:
            reply += "\n\n(I tried to change the editor but my instructions were malformed. Ask me again.)"
    return {"reply": reply or "Done.", "actions": actions}
