#!/bin/sh
# The `workspace` container's main process: runs the Coder agents the lane's template (coder-template/main.tf)
# hands over in /agents. A start writes /agents/<id>/{token,init.sh}; a stop touches /agents/<id>/stop. Each
# agent runs as the image's `coder` user with HOME=/home/coder, as in the chart's pod, and logs to
# /agents/<id>/agent.log, which run-e2e.sh copies into .logs.
set -u
while :; do
  for d in /agents/*; do
    [ -d "$d" ] || continue
    case "$d" in *.tmp) continue ;; esac
    if [ -f "$d/stop" ]; then
      [ -f "$d/pid" ] && kill "$(cat "$d/pid")" 2>/dev/null
      rm -f "$d/pid" "$d/token" "$d/init.sh" "$d/stop"
      touch "$d/stopped"
      continue
    fi
    if [ -f "$d/init.sh" ] && [ ! -f "$d/pid" ] && [ ! -f "$d/stopped" ]; then
      echo "starting agent $(basename "$d")"
      (
        cd /home/coder || exit 1
        CODER_AGENT_TOKEN="$(cat "$d/token")"
        export CODER_AGENT_TOKEN
        exec sh "$d/init.sh"
      ) >>"$d/agent.log" 2>&1 &
      echo $! >"$d/pid"
    fi
  done
  sleep 1
done
