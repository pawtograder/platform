#!/usr/bin/env bash
# One-time bootstrap of the shared-preview seed-user password in OpenBao.
#
# Every preview namespace's seed job consumes the same password via an
# ExternalSecret that pulls from kv/apps/pawtograder/preview-shared. The
# password is single-cluster scoped (not per-env) since all previews are
# equally untrusted and the password lets any preview reviewer log in to
# any preview by entering a documented sample email.
#
# Run this once per cluster. The script prints the password — capture
# it, share with reviewers (e.g. via 1Password) — re-runs rotate it.
#
# Usage:
#   ./scripts/setup-openbao-preview-shared.sh           # generates fresh
#   PASSWORD=foo ./scripts/setup-openbao-preview-shared.sh   # use given
#   ./scripts/setup-openbao-preview-shared.sh --rotate  # force rotate
#
# Requires `bao` (or `vault`) on PATH and BAO_ADDR/BAO_TOKEN exported.

set -euo pipefail

usage() {
  cat <<EOF
Usage: $0 [--rotate]

  --rotate         Generate a new random password even if one already
                   exists. Without this, the script refuses to overwrite
                   an existing path. (Either way: \`bao kv put\` always
                   replaces the entire object.)
  --bao-mount      KV mount name (default: kv).
  --bao-path       Path within the mount (default: apps/pawtograder/preview-shared).

Env:
  PASSWORD         If set, used verbatim instead of generating a random one.

The script prints the password to stdout and writes nothing else there,
so it's safe to capture with command substitution.
EOF
}

ROTATE=0
BAO_MOUNT="kv"
BAO_PATH="apps/pawtograder/preview-shared"
# Accept both --flag=value and --flag value (the usage() text advertises
# the space-separated form, so the parser has to handle both).
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rotate)        ROTATE=1; shift ;;
    --bao-mount=*)   BAO_MOUNT="${1#*=}"; shift ;;
    --bao-path=*)    BAO_PATH="${1#*=}"; shift ;;
    --bao-mount)     BAO_MOUNT="${2:?--bao-mount requires a value}"; shift 2 ;;
    --bao-path)      BAO_PATH="${2:?--bao-path requires a value}"; shift 2 ;;
    -h|--help)       usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

CLI=""
if command -v bao >/dev/null 2>&1; then
  CLI=bao
elif command -v vault >/dev/null 2>&1; then
  CLI=vault
  : "${VAULT_ADDR:=${BAO_ADDR:-}}"
  : "${VAULT_TOKEN:=${BAO_TOKEN:-}}"
  export VAULT_ADDR VAULT_TOKEN
else
  echo "ERROR: neither 'bao' nor 'vault' found on PATH" >&2
  exit 2
fi

$CLI status >/dev/null 2>&1 || {
  echo "ERROR: $CLI status failed — set BAO_ADDR/BAO_TOKEN (or VAULT_*) and log in" >&2
  exit 1
}

# Refuse to overwrite an existing password unless --rotate is set. Use
# `bao kv get` and check the return code so we only see "exists" / "doesn't"
# without leaking the value.
if $CLI kv get -mount="$BAO_MOUNT" "$BAO_PATH" >/dev/null 2>&1; then
  if [ "$ROTATE" -ne 1 ]; then
    echo "ERROR: ${BAO_MOUNT}/${BAO_PATH} already exists. Pass --rotate to overwrite." >&2
    exit 1
  fi
  echo "Existing password at ${BAO_MOUNT}/${BAO_PATH} — rotating." >&2
fi

# Generate a 24-byte random password if none supplied. Strip URL-special
# chars so it copy-pastes cleanly into a browser address bar and round-
# trips through whatever JSON we embed it in for the PR comment.
PASSWORD="${PASSWORD:-$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-24)}"

# Write to Bao. stdin form so the password never lands in a shell argv
# that could show up in `ps`.
jq -n --arg p "$PASSWORD" '{seed_user_password: $p}' \
  | $CLI kv put -mount="$BAO_MOUNT" "$BAO_PATH" - >/dev/null

# Print ONLY the password to stdout so callers can capture it cleanly.
echo "$PASSWORD"

# Status / next-steps to stderr (won't pollute stdout capture).
{
  echo
  echo "Wrote password to ${BAO_MOUNT}/${BAO_PATH} (key=seed_user_password)."
  echo
  echo "Next steps:"
  echo "  1. In preview values, set:"
  echo "       seed:"
  echo "         externalSecret:"
  echo "           enabled: true"
  echo "  2. helm upgrade. ESO syncs the password into the seed job, which"
  echo "     overwrites the demo users' encrypted_password on next reset."
  echo "  3. Existing preview namespaces need a fresh seed run to pick up"
  echo "     the new password — set migrations.resetOnDrift=true on next"
  echo "     deploy, or kubectl delete the demo class and let the seed"
  echo "     post-upgrade hook reseed."
} >&2
