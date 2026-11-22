#!/bin/sh
# Start Short Maker on http://127.0.0.1:8765
cd "$(dirname "$0")"
command -v ffmpeg >/dev/null || { echo "ffmpeg is required: brew install ffmpeg"; exit 1; }
command -v uv >/dev/null || { echo "uv is required: curl -LsSf https://astral.sh/uv/install.sh | sh"; exit 1; }
uv sync --python 3.13 -q
PORT="${PORT:-8765}"
echo "Short Maker -> http://127.0.0.1:$PORT"
exec uv run --python 3.13 uvicorn app.server:app --host 127.0.0.1 --port "$PORT"
