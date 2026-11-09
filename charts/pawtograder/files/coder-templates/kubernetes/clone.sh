#!/bin/sh
# The "Git Clone" startup script, rendered by main.tf. Clones the repository on the first start; later starts keep it.
# A destination that isn't that clone fails the step and is left as it is: it may hold the student's work.
URL='${url}'
DIR='${dir}'
LIMIT=${limit}
AUTH='${auth}'

fail() {
  echo "Git Clone failed: $*" >&2
  exit 1
}

# repo_url's validation lets "" through for template import, and Coder then accepts it at creation.
[ -n "$URL" ] || fail "the workspace's repo_url is empty; recreate it with the repository's clone URL."

if [ -e "$DIR" ] || [ -L "$DIR" ]; then
  if [ -d "$DIR" ] && [ -z "$(ls -A "$DIR")" ]; then
    rmdir "$DIR"
  elif ! top="$(cd "$DIR" 2>/dev/null && pwd -P)" || [ "$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null)" != "$top" ]; then
    fail "$DIR exists but isn't a git checkout. Nothing was changed; move it aside and restart the workspace."
  elif ! git -C "$DIR" rev-parse --verify --quiet 'HEAD^{commit}' >/dev/null; then
    fail "$DIR has no commit checked out (an interrupted clone?). Nothing was changed; move it aside and restart the workspace."
  elif [ "$(git -C "$DIR" config --get remote.origin.url)" != "$URL" ]; then
    fail "$DIR is a clone of '$(git -C "$DIR" config --get remote.origin.url)', not $URL. Nothing was changed; move it aside and restart the workspace."
  else
    echo "$DIR is already a clone of $URL; keeping it."
    exit 0
  fi
fi

# Without a link, git's credential helper would wait for one instead of failing.
if ! out="$(timeout 60 coder external-auth access-token "$AUTH" 2>&1)"; then
  fail "the workspace owner hasn't linked their $AUTH account: $out"
fi
unset out

# The clone lands in a new directory beside DIR, on the same filesystem, and is renamed into place, so DIR never holds
# a partial clone. Only that directory is ever removed; one a killed run left behind is left alone.
TMP="$(mktemp -d "$(dirname "$DIR")/.$(basename "$DIR").cloning.XXXXXX")" || fail "couldn't create a staging directory beside $DIR"
trap 'rm -rf "$TMP"' EXIT
trap 'exit 1' HUP INT TERM
echo "Cloning $URL into $DIR..."
timeout -k 10 "$LIMIT" git clone -- "$URL" "$TMP/clone"
code=$?
case "$code" in
  0) ;;
  124 | 137) fail "git clone didn't finish within $LIMIT seconds (is the server reachable, and the $AUTH account still linked?)" ;;
  *) fail "git clone exited with $code" ;;
esac
mv "$TMP/clone" "$DIR" || fail "couldn't move the clone into $DIR"
echo "Cloned $URL into $DIR."
