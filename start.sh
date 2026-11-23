#!/bin/sh
# Start Short Maker on http://127.0.0.1:8765 in the background and give the prompt back.
#   ./start.sh          start in the background (log: data/server.log)
#   ./start.sh --fg     run in this terminal instead (Ctrl+C stops it)
#   ./stop.sh           stop it
cd "$(dirname "$0")" || exit 1
command -v ffmpeg >/dev/null || { echo "ffmpeg is required: brew install ffmpeg"; exit 1; }
command -v uv >/dev/null || { echo "uv is required: curl -LsSf https://astral.sh/uv/install.sh | sh"; exit 1; }
PORT="${PORT:-8765}"
URL="http://127.0.0.1:$PORT"
PIDFILE="data/server.pid"
LOG="data/server.log"
mkdir -p data

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Short Maker is already running -> $URL   (./stop.sh to stop it)"
  exit 0
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use. If that's an older Short Maker, run ./stop.sh first."
  exit 1
fi

echo "Checking dependencies..."
uv sync --python 3.13 -q || exit 1

if [ "$1" = "--fg" ]; then
  echo "Short Maker -> $URL   (Ctrl+C to stop)"
  exec uv run --python 3.13 uvicorn app.server:app --host 127.0.0.1 --port "$PORT"
fi

nohup .venv/bin/python -m uvicorn app.server:app --host 127.0.0.1 --port "$PORT" >>"$LOG" 2>&1 &
echo $! >"$PIDFILE"

# wait until it answers (up to ~20 s), so the link works when we print it
i=0
while [ $i -lt 40 ]; do
  if curl -s -o /dev/null "$URL/api/health"; then
    echo "Short Maker is running -> $URL"
    echo "Log: $LOG   Stop: ./stop.sh"
    exit 0
  fi
  if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "Short Maker failed to start. Last lines of $LOG:"
    tail -n 15 "$LOG"
    rm -f "$PIDFILE"
    exit 1
  fi
  sleep 0.5
  i=$((i + 1))
done
echo "Short Maker is starting (slow first start) -> $URL   Log: $LOG"
