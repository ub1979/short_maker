#!/bin/sh
# Stop the Short Maker server started with ./start.sh (or any Short Maker on the port).
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8765}"
PIDFILE="data/server.pid"

pids=""
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  pids="$(cat "$PIDFILE")"
fi
# also catch a server started another way (e.g. an older ./start.sh in a terminal)
for p in $(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do
  if ps -o command= -p "$p" | grep -q "uvicorn app.server:app"; then
    pids="$pids $p"
  fi
done

if [ -z "$(echo "$pids" | tr -d ' ')" ]; then
  echo "Short Maker isn't running."
  rm -f "$PIDFILE"
  exit 0
fi

kill $pids 2>/dev/null
i=0
while [ $i -lt 20 ]; do
  alive=""
  for p in $pids; do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done
  [ -z "$alive" ] && break
  sleep 0.5
  i=$((i + 1))
done
[ -n "$alive" ] && kill -9 $alive 2>/dev/null
rm -f "$PIDFILE"
echo "Short Maker stopped."
