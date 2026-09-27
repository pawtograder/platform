#!/usr/bin/env bash
#
# Verifies the two properties run.sh must hold when it is interrupted:
#
#   1. it exits NON-ZERO, so CI cannot mistake a truncated run for a passing one, and
#   2. it leaves NO container behind.
#
# Both come from the same trap arrangement and it is easy to fix one while breaking the other. That
# is what happened: `trap cleanup EXIT INT TERM` removed the container correctly, but cleanup reads
# `$?`, and on the signal paths `$?` is the status of whatever command finished last. A signal
# arriving just after a successful step made an interrupted run exit 0. The fix is to let EXIT do
# the cleanup and give each signal a handler that only chooses the status.
#
#   tests/manual/per_org_async_leases/interrupt_check.sh
#
# Takes about as long as run.sh needs to start its container, twice, rather than a full harness run.
#
# WHY `set -m`. A background job of a non-interactive shell inherits SIGINT ignored, and a signal
# ignored on entry cannot be trapped, so `kill -INT` on a plain `cmd &` is silently a no-op: run.sh
# would run to completion and this script would report a pass it never tested. Job control puts the
# job in its own process group with default signal dispositions, which is also what a terminal gives
# Ctrl-C and what a CI runner gives a cancelled step. SIGTERM is never ignored this way, so it is
# checked as the second case.
set -euo pipefail
set -m

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RC=0

check_signal() {
  local signal="$1" expected="$2" port="$3"
  local run_pid container status found=0 gone=0

  HARNESS_PORT="$port" bash "$HERE/run.sh" >/dev/null 2>&1 &
  run_pid=$!
  # run.sh names its container after its own PID, which is this job's PID.
  container="pawtograder-orglease-harness-$run_pid"

  # Signal only once the container exists, or the run proves nothing about removing it.
  for _ in $(seq 1 180); do
    if docker ps --filter "name=^${container}$" --format '{{.Names}}' | grep -q .; then found=1; break; fi
    kill -0 "$run_pid" 2>/dev/null || break
    sleep 1
  done
  if [ "$found" != "1" ]; then
    echo "FAIL  [$signal] container $container never appeared"
    kill -9 "$run_pid" 2>/dev/null || true
    RC=1
    return
  fi

  echo ">> [$signal] container is up; signalling run.sh (pid $run_pid)"
  kill "-$signal" "$run_pid"
  set +e
  wait "$run_pid"
  status=$?
  set -e
  echo ">> [$signal] run.sh exited with status $status"

  # Removal happens in the EXIT trap, which runs after the signal handler.
  for _ in $(seq 1 30); do
    docker ps -a --filter "name=^${container}$" --format '{{.Names}}' | grep -q . || { gone=1; break; }
    sleep 1
  done

  if [ "$status" -eq 0 ]; then
    echo "FAIL  [$signal] interrupted run exited 0; CI would read a truncated run as a pass"
    RC=1
  elif [ "$status" -ne "$expected" ]; then
    echo "FAIL  [$signal] expected status $expected, got $status"
    RC=1
  else
    echo "PASS  [$signal] interrupted run exited $status"
  fi

  if [ "$gone" != "1" ]; then
    echo "FAIL  [$signal] container $container still present after the signal"
    docker rm -f "$container" >/dev/null 2>&1 || true
    RC=1
  else
    echo "PASS  [$signal] no container left behind"
  fi
}

check_signal INT  130 "${HARNESS_PORT:-55441}"
check_signal TERM 143 "$(( ${HARNESS_PORT:-55441} + 1 ))"

if [ "$RC" -eq 0 ]; then echo ">> interrupt handling verified for SIGINT and SIGTERM"; fi
exit "$RC"
