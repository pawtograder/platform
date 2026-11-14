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

# Equivalent spellings of one repository compare equal: no trailing / or .git, and the scheme and host in lowercase.
normalize() {
  printf '%s\n' "$1" | awk '{ sub(/\/+$/, ""); sub(/\.git$/, ""); if (match($0, /^[^:\/]+:\/\/[^\/]*/)) $0 = tolower(substr($0, 1, RLENGTH)) substr($0, RLENGTH + 1); print }'
}

# repo_url's validation lets "" through for template import, and Coder then accepts it at creation.
[ -n "$URL" ] || fail "the workspace's repo_url is empty; recreate it with the repository's clone URL."

if [ -e "$DIR" ] || [ -L "$DIR" ]; then
  # mv would put the clone inside a linked directory, and VS Code would open the wrong folder.
  [ ! -L "$DIR" ] || fail "$DIR is a symbolic link. Nothing was changed; move it aside and restart the workspace."
  origin="$(git -C "$DIR" config --get remote.origin.url 2>/dev/null)"
  if [ -d "$DIR" ] && [ -z "$(ls -A "$DIR")" ]; then
    rmdir "$DIR" || fail "couldn't remove the empty directory $DIR"
  elif ! top="$(cd "$DIR" 2>/dev/null && pwd -P)" || [ "$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null)" != "$top" ]; then
    fail "$DIR exists but isn't a git checkout. Nothing was changed; move it aside and restart the workspace."
  elif [ "$(normalize "$origin")" != "$(normalize "$URL")" ]; then
    # The origin isn't printed: it can hold a username and token in forms no redaction catches (https::https://…).
    fail "$DIR is a checkout of another repository, not $URL. Nothing was changed; move it aside and restart the workspace."
  else
    # Only a finished clone is renamed into place, so a checkout without a commit is an empty repository's.
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
