#!/usr/bin/env bash
# Usage: deploy/scripts/ensure-database.sh <environment> <app> <server>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/deploy/environments/$1.yaml"
app="$2"
server="$3"
val() { yq -r "$1" "$ENV_FILE"; }
k() { kubectl --context "$(val .kubeContext)" -n "$(val .namespace)" "$@"; }

case "$server" in
  pawtograder) pod=pawtograder-postgres-0 ;;
  *) pod="$server-0" ;;
esac

upper="$(echo "$app" | tr '[:lower:]-' '[:upper:]_')"
password="$(k get secret "$app-db-credentials" -o "jsonpath={.data.${upper}_DB_PASSWORD}" | base64 -d)"
[ -n "$password" ] || { echo "Secret $app-db-credentials has no ${upper}_DB_PASSWORD" >&2; exit 1; }
case "$password" in *[!A-Za-z0-9]*) echo "$app password must be alphanumeric" >&2; exit 1 ;; esac

k wait --for=condition=Ready "pod/$pod" --timeout=300s >/dev/null

# SQL goes over stdin to keep the password out of the process list.
k exec -i "$pod" -c postgres -- sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -qAt -h localhost -U "${POSTGRES_USER:-postgres}" -d postgres -v ON_ERROR_STOP=1' <<SQL
SELECT format('CREATE ROLE %I LOGIN', '$app')
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$app') \gexec
ALTER ROLE "$app" WITH LOGIN PASSWORD '$password';
SELECT format('CREATE DATABASE %I OWNER %I', '$app', '$app')
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$app') \gexec
SQL
echo "database $app ready on $server"
