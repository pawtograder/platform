#!/usr/bin/env bash
#
# Run the Discord REST mock (tests/mocks/discord/server.ts) where the Supabase Edge Functions can
# actually reach it.
#
# WHY A CONTAINER AND NOT `npx tsx tests/mocks/discord/server.ts`
#
# Edge Functions run inside the supabase_edge_runtime container. A mock bound to the host's
# 127.0.0.1 is that container's own loopback from the inside, so every Discord call gets
# ECONNREFUSED; and in a sandbox with an egress proxy, host-directed container traffic is
# intercepted and answered 502, so `host.docker.internal` does not save it either. Putting the mock
# ON the Supabase Docker network removes both problems at once: the edge runtime resolves
# `discord-mock` through Docker's DNS and talks to it container-to-container, and the published
# 127.0.0.1:8788 keeps it reachable from the test process on the host.
#
# So there is one URL for two audiences and they have to agree on the hostname:
#
#   DISCORD_API_BASE_URL=http://discord-mock:8788/api/v10   (edge functions, via Docker DNS)
#   DISCORD_MOCK_URL=http://127.0.0.1:8788                  (tests, via the published port)
#
# The host needs `127.0.0.1 discord-mock` in /etc/hosts for anything on the host that uses the
# container hostname, and `discord-mock` in no_proxy so a configured HTTP proxy does not swallow it.
# Both are checked below and reported rather than assumed.
#
# Usage:
#   scripts/start-discord-mock.sh            # start if not already healthy, then print the env vars
#   scripts/start-discord-mock.sh --restart  # recreate the container even if it is healthy
#   scripts/start-discord-mock.sh --stop     # stop and remove it
#   scripts/start-discord-mock.sh --status   # report without changing anything
#
# Safe to run twice: a healthy container is left alone (so it cannot wipe the mock state out from
# under a run in progress), and a dead or half-created one is removed and rebuilt.

set -euo pipefail

CONTAINER="${DISCORD_MOCK_CONTAINER:-discord-mock}"
PORT="${DISCORD_MOCK_PORT:-8788}"
IMAGE="${DISCORD_MOCK_IMAGE:-node:22-alpine}"
# Overridable so the /etc/hosts handling can be exercised without touching the real file.
HOSTS_FILE="${DISCORD_MOCK_HOSTS_FILE:-/etc/hosts}"
READY_TIMEOUT_SECONDS="${DISCORD_MOCK_READY_TIMEOUT:-30}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '[discord-mock] %s\n' "$*" >&2; }
die() {
  printf '[discord-mock] ERROR: %s\n' "$*" >&2
  exit 1
}

# CONTAINER is used both as a Docker object name and as the hostname written into $HOSTS_FILE, and it
# reaches `docker ps --filter name=^...$` and a `grep -E` pattern, so a value with regex or shell
# metacharacters in it would be interpreted rather than matched. Docker's own rule for a name is
# stricter than that, so requiring it up front costs nothing and removes the question.
case "$CONTAINER" in
*[!A-Za-z0-9_.-]* | "" | [!A-Za-z0-9]*) die "DISCORD_MOCK_CONTAINER='${CONTAINER}' is not a valid container name or hostname (expected [A-Za-z0-9][A-Za-z0-9_.-]*)" ;;
esac
case "$PORT" in
'' | *[!0-9]*) die "DISCORD_MOCK_PORT='${PORT}' is not a port number" ;;
esac

# ---------------------------------------------------------------------------
# Which Docker network is Supabase on
# ---------------------------------------------------------------------------

# Read it off the running database container rather than hardcoding
# `supabase_network_pawtograder-platform`: the name is derived from the project directory, so a
# clone under a different directory name has a different network and a hardcoded value fails with a
# confusing "network not found" instead of doing the obvious thing.
detect_network() {
  if [ -n "${SUPABASE_NETWORK:-}" ]; then
    printf '%s' "$SUPABASE_NETWORK"
    return 0
  fi
  # SUPABASE_PROJECT names the project under test. CI sets it per run
  # (pawtograder-platform-<run_id>-<attempt>) so two e2e-local jobs on the same self-hosted runner do
  # not clobber each other's stack -- which means `head -n 1` over every supabase_db_* container can
  # pick the OTHER job's database, attach the mock to the wrong network, and leave this job's edge
  # runtime unable to resolve `discord-mock`. With DISCORD_MOCK_REQUIRED=1 that is not a skip any
  # more, it is every Discord test failing for a reason that looks nothing like the cause.
  local db
  if [ -n "${SUPABASE_PROJECT:-}" ] && docker ps --format '{{.Names}}' | grep -qx "supabase_db_${SUPABASE_PROJECT}"; then
    db="supabase_db_${SUPABASE_PROJECT}"
  else
    # No project named, so fall back to discovery -- but refuse to guess between projects rather than
    # silently attaching to an arbitrary one.
    local dbs db_count
    dbs="$(docker ps --filter 'name=^supabase_db_' --format '{{.Names}}' || true)"
    db_count="$(printf '%s' "$dbs" | grep -c . || true)"
    if [ "$db_count" -gt 1 ]; then
      log "ERROR: several Supabase stacks are running:"
      printf '%s\n' "$dbs" | sed 's/^/         /'
      log "       set SUPABASE_PROJECT (or SUPABASE_NETWORK) so the mock joins the right one."
      return 1
    fi
    db="$(printf '%s' "$dbs" | head -n 1)"
  fi
  if [ -n "$db" ]; then
    local from_db
    from_db="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$db" 2>/dev/null |
      grep '^supabase_network_' | head -n 1)"
    if [ -n "$from_db" ]; then
      printf '%s' "$from_db"
      return 0
    fi
  fi
  # Supabase is down, or its db container was renamed. A single candidate network is still
  # unambiguous; more than one is not, and guessing between two projects would attach the mock to
  # the wrong stack, which fails as a silent 404 rather than as an error.
  local candidates count
  candidates="$(docker network ls --format '{{.Name}}' | grep '^supabase_network_' || true)"
  count="$(printf '%s' "$candidates" | grep -c . || true)"
  if [ "$count" = "1" ]; then
    printf '%s' "$candidates"
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Container state
# ---------------------------------------------------------------------------

container_exists() {
  docker ps -a --filter "name=^${CONTAINER}$" --format '{{.Names}}' | grep -q "^${CONTAINER}$"
}

container_running() {
  docker ps --filter "name=^${CONTAINER}$" --format '{{.Names}}' | grep -q "^${CONTAINER}$"
}

# Ask the mock's own control plane. Prefer the published port, since that is the path the tests use
# and so the one worth proving; fall back to busybox wget inside the container, which still answers
# when the port publish is what is broken.
health() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --noproxy '*' --max-time 2 "http://127.0.0.1:${PORT}/__mock/health" 2>/dev/null && return 0
  fi
  docker exec "$CONTAINER" wget -qO- "http://127.0.0.1:${PORT}/__mock/health" 2>/dev/null && return 0
  return 1
}

wait_for_health() {
  local deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if body="$(health)"; then
      printf '%s' "$body"
      return 0
    fi
    if ! container_running; then
      log "container exited while starting up; last log lines:"
      docker logs --tail 30 "$CONTAINER" >&2 2>/dev/null || true
      return 1
    fi
    sleep 0.5
  done
  log "timed out after ${READY_TIMEOUT_SECONDS}s; last log lines:"
  docker logs --tail 30 "$CONTAINER" >&2 2>/dev/null || true
  return 1
}

remove_container() {
  if container_exists; then
    log "removing existing container ${CONTAINER}"
    docker rm -f "$CONTAINER" >/dev/null
  fi
}

start_container() {
  local network="$1"
  [ -x "${REPO_ROOT}/node_modules/.bin/tsx" ] ||
    die "node_modules/.bin/tsx is missing. Run 'npm install' first: the mock is TypeScript run through tsx."

  log "starting ${CONTAINER} on network ${network}"
  docker run -d --name "$CONTAINER" \
    --network "$network" \
    -p "127.0.0.1:${PORT}:${PORT}" \
    -v "${REPO_ROOT}:/app" \
    -w /app \
    -e DISCORD_MOCK_HOST=0.0.0.0 \
    -e "DISCORD_MOCK_PORT=${PORT}" \
    "$IMAGE" \
    ./node_modules/.bin/tsx tests/mocks/discord/server.ts >/dev/null
}

# ---------------------------------------------------------------------------
# Host-side prerequisites
# ---------------------------------------------------------------------------

# `discord-mock` has to resolve on the host too, because DISCORD_API_BASE_URL is one value shared by
# the edge runtime and by anything host-side that reads it. Appending to /etc/hosts needs root, so
# this tries a non-interactive sudo and otherwise prints the command rather than failing the start:
# the tests themselves use 127.0.0.1 and work without it.
ensure_hosts_entry() {
  if grep -qE "^[^#]*[[:space:]]${CONTAINER}([[:space:]]|$)" "$HOSTS_FILE" 2>/dev/null; then
    return 0
  fi
  local line="127.0.0.1 ${CONTAINER}"
  if printf '%s\n' "$line" >>"$HOSTS_FILE" 2>/dev/null; then
    log "added '${line}' to ${HOSTS_FILE}"
    return 0
  fi
  # `sudo -n tee`, not `sudo -n sh -c "... '$line' >> '$HOSTS_FILE'"`. The second builds a shell
  # program out of two overridable variables and runs it as root, so a single quote anywhere in
  # DISCORD_MOCK_CONTAINER or DISCORD_MOCK_HOSTS_FILE ends the quoting and the rest executes with
  # root's privileges. Here root runs a fixed program and the variables are only ever arguments to
  # it, which no amount of quoting in their values can change.
  if printf '%s\n' "$line" | sudo -n tee -a "$HOSTS_FILE" >/dev/null 2>&1; then
    log "added '${line}' to ${HOSTS_FILE} (via sudo)"
    return 0
  fi
  log "WARNING: ${HOSTS_FILE} has no '${CONTAINER}' entry and it could not be added."
  log "         Host-side code that uses the container hostname will not resolve. Fix with:"
  log "           echo '${line}' | sudo tee -a ${HOSTS_FILE}"
}

check_no_proxy() {
  case ",${no_proxy:-}${NO_PROXY:+,$NO_PROXY}," in
  *",${CONTAINER},"*) return 0 ;;
  esac
  if [ -n "${http_proxy:-${HTTP_PROXY:-}}" ]; then
    log "WARNING: an HTTP proxy is configured but '${CONTAINER}' is not in no_proxy."
    log "         Add it before running anything that talks to the mock by hostname:"
    log "           export no_proxy=\"\$no_proxy,${CONTAINER}\" NO_PROXY=\"\$NO_PROXY,${CONTAINER}\""
  fi
}

print_env() {
  cat <<EOF

Mock is up. Export these (the first is what the edge functions need, via .env.local):

  export DISCORD_API_BASE_URL=http://${CONTAINER}:${PORT}/api/v10
  export DISCORD_MOCK_URL=http://127.0.0.1:${PORT}
  export no_proxy="\$no_proxy,${CONTAINER}" NO_PROXY="\$NO_PROXY,${CONTAINER}"

DISCORD_API_BASE_URL must be in the --env-file that 'supabase functions serve' was started with;
changing it here does not reach an already-running edge runtime.
EOF
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

ACTION="start"
case "${1:-}" in
--stop) ACTION="stop" ;;
--restart) ACTION="restart" ;;
--status) ACTION="status" ;;
"") ACTION="start" ;;
-h | --help)
  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
  ;;
*) die "unknown argument '$1' (expected --stop, --restart, --status, or nothing)" ;;
esac

command -v docker >/dev/null 2>&1 || die "docker is not on PATH"

case "$ACTION" in
stop)
  if container_exists; then
    remove_container
    log "stopped"
  else
    log "not running; nothing to stop"
  fi
  exit 0
  ;;
status)
  if body="$(health)"; then
    log "healthy: ${body}"
    exit 0
  fi
  if container_exists; then
    log "container exists but is not answering /__mock/health"
    exit 1
  fi
  log "not running"
  exit 1
  ;;
esac

if [ "$ACTION" = "start" ] && container_running; then
  # Idempotent path: a healthy mock is left exactly as it is, state and call log included, so a
  # second run of this script cannot reset the world under a test that is already using it.
  if body="$(health)"; then
    log "already healthy, leaving it alone: ${body}"
    ensure_hosts_entry
    check_no_proxy
    print_env
    exit 0
  fi
  log "running but not answering /__mock/health; recreating"
fi

NETWORK="$(detect_network)" || die "could not find a supabase_network_* Docker network. Is 'supabase start' done? Set SUPABASE_NETWORK to override."

remove_container
start_container "$NETWORK"

if ! body="$(wait_for_health)"; then
  die "the mock did not become healthy"
fi
log "healthy: ${body}"

ensure_hosts_entry
check_no_proxy
print_env
