#!/usr/bin/env bash
# Shared helpers for the pawtograder cluster CLIs (deploy-edge-functions.sh,
# supabase-db.sh). Source this file; it is not meant to be executed directly.
#
# Target selection is uniform across the tools:
#   --env staging        (default)  -> namespace pawtograder-staging
#   --preview <id>                   -> namespace pawtograder-preview-pr-<id>
#   --namespace <ns>                 -> that namespace verbatim
# The Helm release is always "pawtograder" in every pawtograder namespace.

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 1; }
}

# resolve_namespace <env> <preview_id> <explicit_ns> -> echoes the namespace.
# Precedence: explicit --namespace > --preview > --env (default "staging").
resolve_namespace() {
  local env="${1:-}" preview="${2:-}" ns="${3:-}"
  if [ -n "$ns" ];      then printf '%s\n' "$ns"; return 0; fi
  if [ -n "$preview" ]; then printf 'pawtograder-preview-pr-%s\n' "$preview"; return 0; fi
  case "${env:-staging}" in
    staging) printf 'pawtograder-staging\n' ;;
    *) echo "unknown --env '${env}' (use 'staging', or --preview <id>, or --namespace <ns>)" >&2; return 1 ;;
  esac
}

# assert_namespace <ns> -> exit 1 with a friendly hint if it isn't reachable.
assert_namespace() {
  local ns="$1"
  kubectl get ns "$ns" >/dev/null 2>&1 || {
    echo "namespace '$ns' not found — is KUBECONFIG pointed at the right cluster?" >&2
    echo "  current context: $(kubectl config current-context 2>/dev/null || echo '<none>')" >&2
    exit 1
  }
}
