#!/usr/bin/env bash
# Pawtograder migration runner.
#
# Applies every supabase/migrations/*.sql file in lexicographic order against
# the database identified by libpq env vars (PGHOST, PGUSER, PGDATABASE,
# PGPASSWORD, etc.). Tracks applied versions in
# supabase_migrations.schema_migrations — the same table the supabase CLI
# uses, so a database bootstrapped with this runner is interchangeable with
# one bootstrapped via `supabase db push`.

set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=postgres}"
: "${PGPASSWORD:?PGPASSWORD is required}"
export PGHOST PGUSER PGDATABASE PGPASSWORD

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"

echo "[migrate] target=${PGUSER}@${PGHOST}:${PGPORT:-5432}/${PGDATABASE}"
echo "[migrate] source=${MIGRATIONS_DIR}"

psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version  TEXT PRIMARY KEY,
  statements TEXT[],
  name     TEXT
);
SQL

applied=0
skipped=0
shopt -s nullglob
files=( "${MIGRATIONS_DIR}"/*.sql )
if [ "${#files[@]}" -eq 0 ]; then
  echo "[migrate] no migration files found in ${MIGRATIONS_DIR}" >&2
  exit 1
fi

# Lexicographic sort is correct for supabase's <timestamp>_<name>.sql convention.
IFS=$'\n' sorted=( $(printf '%s\n' "${files[@]}" | sort) )
unset IFS

for f in "${sorted[@]}"; do
  base="$(basename "$f" .sql)"
  version="${base%%_*}"
  name="${base#*_}"
  # Use psql --set with the :'var' literal-quoting form so values are quoted
  # by psql, never by the shell. This is the equivalent of bound parameters
  # and is safe even if filenames contain quotes or other unusual characters.
  exists="$(psql -tAc --set=ver="${version}" \
    "SELECT 1 FROM supabase_migrations.schema_migrations WHERE version=:'ver'")"
  if [ "${exists}" = "1" ]; then
    skipped=$((skipped+1))
    continue
  fi
  echo "[migrate] applying ${base}"
  psql -v ON_ERROR_STOP=1 --single-transaction -f "$f"
  psql -v ON_ERROR_STOP=1 --set=ver="${version}" --set=mname="${name}" -c \
    "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES (:'ver', :'mname') ON CONFLICT (version) DO NOTHING;"
  applied=$((applied+1))
done

echo "[migrate] done — applied=${applied} skipped=${skipped}"
