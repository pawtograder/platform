#!/usr/bin/env bash
# =============================================================================
# Non-interactive Canvas bootstrap for the e2e stack.
#
# Run AFTER `docker compose up -d` (postgres/redis healthy). It:
#   1. Creates + migrates the Canvas database (idempotent).
#   2. Runs db:initial_setup which, with the CANVAS_LMS_ADMIN_* env vars set in
#      docker-compose.yml, creates the site admin NON-interactively.
#   3. Mints an admin API access token via rails runner and prints it.
#
# All steps are safe to re-run. The admin token line is printed to stdout as:
#     CANVAS_ADMIN_TOKEN=<token>
# Capture it; it is NOT written to any committed file.
#
# Usage:
#   tests/e2e/canvas/bootstrap.sh
# Env:
#   COMPOSE        compose invocation (default: docker compose -f <this dir>/docker-compose.yml)
#   CANVAS_LMS_ADMIN_EMAIL / _PASSWORD  (defaults match docker-compose.yml)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="${COMPOSE:-docker compose -f $SCRIPT_DIR/docker-compose.yml}"

ADMIN_EMAIL="${CANVAS_LMS_ADMIN_EMAIL:-canvas@example.com}"
ADMIN_PASSWORD="${CANVAS_LMS_ADMIN_PASSWORD:-canvas-password}"

# Run rake/runner in a throwaway container that shares web's env + network.
# (web itself is busy serving puma; a one-off `run` is cleaner than `exec`.)
run_in_canvas() {
  $COMPOSE run --rm --no-deps -T \
    -e CANVAS_LMS_ADMIN_EMAIL="$ADMIN_EMAIL" \
    -e CANVAS_LMS_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    web "$@"
}

echo "==> Waiting for postgres to be healthy..."
$COMPOSE up -d postgres redis

# Wait until pg accepts connections (compose healthcheck already gates, but be safe)
for i in $(seq 1 30); do
  if $COMPOSE exec -T postgres pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 2
done

echo "==> Creating database (idempotent)..."
# db:create is a no-op if the DB already exists.
run_in_canvas bundle exec rake db:create || true

echo "==> Running initial setup (migrate + load initial data + create admin)..."
# db:initial_setup runs db:migrate + db:load_initial_data (which calls
# configure_admin, reading CANVAS_LMS_ADMIN_EMAIL / _PASSWORD non-interactively).
# On a fresh DB this is the full setup; on an existing DB the migrate is a no-op
# and configure_admin is idempotent (first_or_create on the admin pseudonym).
run_in_canvas bundle exec rake db:initial_setup

echo "==> Bringing up web + jobs..."
$COMPOSE up -d web jobs

echo "==> Waiting for Canvas /health_check ..."
PORT="${CANVAS_HOST_PORT:-80}"
for i in $(seq 1 60); do
  if curl -fsS "http://localhost:${PORT}/health_check" >/dev/null 2>&1; then
    echo "    Canvas is up."
    break
  fi
  sleep 5
  [ "$i" = "60" ] && { echo "ERROR: Canvas did not become healthy"; $COMPOSE logs --tail=50 web; exit 1; }
done

echo "==> Minting admin API access token..."
TOKEN="$(run_in_canvas bundle exec rails runner "$(cat "$SCRIPT_DIR/scripts/mint_admin_token.rb")" 2>/dev/null | tr -d '\r' | grep -E '^TOKEN=' | cut -d= -f2)"

if [ -z "$TOKEN" ]; then
  echo "WARNING: could not mint token automatically. Re-run:"
  echo "  $COMPOSE run --rm --no-deps -T web bundle exec rails runner scripts/mint_admin_token.rb"
  exit 1
fi

echo ""
echo "============================================================"
echo "Canvas bootstrap complete."
echo "  URL       : http://localhost:${PORT}"
echo "  Admin     : ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}"
echo "  API token : (below - export this for the harness)"
echo "------------------------------------------------------------"
echo "CANVAS_ADMIN_TOKEN=${TOKEN}"
echo "============================================================"
