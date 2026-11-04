#!/usr/bin/env bash
# Creates a pull mirror in Forgejo for each action in $MIRRORS, so bare `uses:` names resolve
# against this Forgejo (DEFAULT_ACTIONS_URL) instead of github.com. Safe to rerun.
#
# Env: FORGEJO_URL (Forgejo's Service URL), MIRRORS (JSON file of {repo, url, ref}),
#      MIRROR_INTERVAL, and AUTH_DIR holding a `token` (or, for local testing, `username` and `password`).
set -euo pipefail

FAPI="$FORGEJO_URL/api/v1"
AUTH_DIR=${AUTH_DIR:-/run/forgejo-auth}
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT

# fj METHOD PATH [BODY]: sets $code and leaves the response body in $OUT.
fj() {
  local args=(-sS --connect-timeout 10 --max-time 300 -o "$OUT" -w '%{http_code}' -H 'Content-Type: application/json' -X "$1")
  if [ -f "$AUTH_DIR/token" ]; then
    args+=(-H "Authorization: token $(cat "$AUTH_DIR/token")")
  else
    args+=(-u "$(cat "$AUTH_DIR/username"):$(cat "$AUTH_DIR/password")")
  fi
  [ $# -lt 3 ] || args+=(--data-binary "$3")
  # --max-time covers a migrate, which clones the whole upstream repo before it answers.
  code=$(curl "${args[@]}" "$FAPI$2") || code=000
}
die() { echo "$*" >&2; exit 1; }
# For a failed request: also show the start of Forgejo's answer.
http_die() { echo "$*" >&2; head -c 500 "$OUT" >&2; echo >&2; exit 1; }
norm() { local u=${1%/}; printf '%s' "${u%.git}"; }

deadline=$(( $(date +%s) + 600 ))
until curl -fsS --connect-timeout 5 --max-time 10 -o /dev/null "$FORGEJO_URL/api/healthz"; do
  [ "$(date +%s)" -lt "$deadline" ] || die "Forgejo at $FORGEJO_URL not healthy after 10m"
  sleep 5
done

count=$(jq length "$MIRRORS")
for i in $(seq 0 $((count - 1))); do
  repo=$(jq -r ".[$i].repo" "$MIRRORS")
  url=$(jq -r ".[$i].url" "$MIRRORS")
  ref=$(jq -r ".[$i].ref" "$MIRRORS")
  owner=${repo%%/*} name=${repo#*/}

  fj GET "/orgs/$owner"
  if [ "$code" = 404 ]; then
    fj POST /orgs "$(jq -nc --arg o "$owner" '{username: $o, visibility: "public"}')"
    [ "$code" = 201 ] || http_die "creating org $owner returned $code"
    echo "created org $owner"
  elif [ "$code" != 200 ]; then
    http_die "GET /orgs/$owner returned $code"
  fi

  fj GET "/repos/$repo"
  if [ "$code" = 404 ]; then
    fj POST /repos/migrate "$(jq -nc --arg u "$url" --arg o "$owner" --arg n "$name" --arg i "$MIRROR_INTERVAL" \
      '{clone_addr: $u, repo_owner: $o, repo_name: $n, mirror: true, mirror_interval: $i, private: false, service: "git",
        description: "Pull mirror of \($u), created by the pawtograder chart for Forgejo Actions"}')"
    [ "$code" = 201 ] || http_die "mirroring $url into $repo returned $code"
    echo "mirrored $url into $repo"
  elif [ "$code" = 200 ]; then
    [ "$(jq -r .mirror "$OUT")" = true ] || die "$repo exists in Forgejo and isn't a mirror; rename or delete it so the chart can mirror $url there"
    [ "$(jq -r .private "$OUT")" = false ] || die "$repo is private, so job pods can't clone it anonymously; make it public"
    have=$(jq -r '.original_url // ""' "$OUT")
    [ "$(norm "$have")" = "$(norm "$url")" ] || die "$repo mirrors $have, not $url; delete the repo in Forgejo and rerun so the chart recreates it"
    fj PATCH "/repos/$repo" "$(jq -nc --arg i "$MIRROR_INTERVAL" '{mirror_interval: $i}')"
    [ "$code" = 200 ] || http_die "setting $repo's mirror interval returned $code"
  else
    http_die "GET /repos/$repo returned $code"
  fi

  # The runner clones actions anonymously over the Service URL; check that path, not just the API.
  if ! git ls-remote --exit-code "$FORGEJO_URL/$repo" "refs/tags/$ref" "refs/heads/$ref" >/dev/null; then
    fj POST "/repos/$repo/mirror-sync"
    echo "$repo has no tag or branch $ref; asked Forgejo to sync the mirror, so rerun once it has, or fix the ref" >&2
    exit 1
  fi
  echo "$repo@$ref resolves at $FORGEJO_URL/$repo"
done
