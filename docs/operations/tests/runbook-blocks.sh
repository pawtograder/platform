#!/usr/bin/env bash
# Parse-check and lint every fenced `bash` block in the operational runbooks.
#
# WHY THIS EXISTS
#
# Shell that lives in Markdown is never executed by anything. It rots silently,
# and the rot is invisible until an incident, which is the worst possible time to
# discover that a runbook block no longer parses. PR #950 produced SEVEN
# fail-open fences and TWO cases of "looks exercised but was not":
#
#   * a block-extraction harness whose greedy blockquote strip ate the leading
#     `>` of a continuation-line output redirect, so it silently verified a
#     pipeline that wrote no file; and
#   * an orphaned `while ... do` left by an edit, which nothing noticed until a
#     `bash -n` sweep was added.
#
# Those two share a root with the seven: nothing ran the code.
#
# WHAT THIS CATCHES, measured rather than assumed. I ran the three real defects
# from this branch through both halves before writing this comment:
#
#   * the orphaned `while ... do`   -- CAUGHT, by `bash -n` and by shellcheck
#                                      (SC1072/SC1073), at every severity.
#   * `crons="$(kubectl ... | tr)"` -- NOT caught, at any severity.
#     swallowing kubectl's status
#   * `got="$(kubectl get ...)"`    -- NOT caught, at any severity.
#     ignoring the get's status
#
# So: this gate catches the "block stopped being valid shell" class outright, and
# the quoting/unused-variable/masked-return classes shellcheck knows about. It
# does NOT catch the fail-open class that dominated this PR -- `x="$(cmd)"` where
# `cmd`'s exit status is thrown away is perfectly legal shell and reads fine.
# Nothing short of executing the block finds that. Do not let a green run here
# stand in for the fake-kubectl runs.
#
# WHAT THIS DOES *NOT* DO -- read this before treating a green job as assurance.
#
# This is a PARSE AND LINT check. It does not execute the procedures, does not
# talk to a cluster, and cannot tell you whether a fence actually fences. A green
# run means "every block is syntactically valid bash and shellcheck-clean at
# -S info". It does NOT mean the runbooks are correct, that the gates refuse when
# they should, that a fence is not fail-open, or that the numbers in the
# derivations are still right. Those are verified by extracting each block and
# executing it against a scripted fake `kubectl`, asserting both arms
# independently -- see the evidence tables in the PR #950 commit messages. That
# work is manual on purpose, because the fixtures encode incident-specific state
# that would be dishonest to freeze into a CI assertion.
#
# Usage:  docs/operations/tests/runbook-blocks.sh [file ...]
# Exit:   0 = all blocks parse and lint clean; 1 = any failure, or nothing scanned.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

# The runbooks this sweep is responsible for. Listed EXPLICITLY rather than
# globbed: a glob silently covers less when a file is renamed, and "the sweep
# quietly stopped scanning the file with the fences in it" is the same class of
# defect the sweep exists to catch. A missing file is a hard error below.
DEFAULT_TARGETS=(
  docs/operations/planned-maintenance.md
  docs/operations/disaster-recovery.md
  docs/operations/point-in-time-recovery.md
  docs/operations/incident-response.md
  docs/operations/monitoring-alerting.md
  docs/operations/rollback.md
  docs/operations/production-install.md
  docs/operations/secrets-rotation.md
  docs/operations/data-retention.md
  docs/operations/deployment-channels.md
)

if [ "$#" -gt 0 ]; then
  TARGETS=("$@")
else
  TARGETS=("${DEFAULT_TARGETS[@]}")
fi

missing=0
for t in "${TARGETS[@]}"; do
  [ -f "$t" ] || { echo "ERROR: expected runbook not found: $t" >&2; missing=1; }
done
if [ "$missing" -ne 0 ]; then
  echo "ERROR: the target list is stale. Fix the path or update DEFAULT_TARGETS -- do" >&2
  echo "       not delete the entry, or the sweep stops covering that file silently." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------
# Emits one file per fenced ```bash block into $WORK, named
# <slug>.<index>.<startline>.sh so a failure names the block by source line.
#
# STRIP EXACTLY THE BLOCK'S OWN BLOCKQUOTE DEPTH -- do NOT "simplify" this to a
# greedy `s/^[[:space:]>]*//`. Several of these blocks are nested inside
# blockquotes, so their lines carry a `> ` prefix that has to come off; but the
# blocks also contain shell lines that legitimately BEGIN with `>`, namely
# continuation-line output redirects:
#
#     kubectl ... \
#       | awk '...' \
#       > "$STATE_DIR/replicas.txt"
#
# A greedy strip eats that `>` and turns the redirect into an awk *argument*, so
# the extracted block runs and writes nothing -- which is exactly how this repo
# came to report a verified fence that had never written its state file. Counting
# the opening fence's own `>` markers and removing precisely that many is the
# whole point of this function.
extract() {
  local src="$1" outdir="$2" slug="$3"
  awk -v outdir="$outdir" -v slug="$slug" '
    # opening fence: capture indentation + blockquote depth
    !inblock && /^[[:space:]]*(>[[:space:]]?)*```bash[[:space:]]*$/ {
      line = $0
      depth = 0
      # count leading "> " markers, tolerating indentation before/between them
      tmp = line
      sub(/^[[:space:]]+/, "", tmp)
      while (substr(tmp, 1, 1) == ">") {
        depth++
        tmp = substr(tmp, 2)
        sub(/^[[:space:]]?/, "", tmp)
      }
      inblock = 1
      start = NR + 1
      n++
      out = sprintf("%s/%s.%03d.L%d.sh", outdir, slug, n, start)
      printf "" > out
      next
    }
    inblock && /^[[:space:]]*(>[[:space:]]?)*```[[:space:]]*$/ {
      inblock = 0
      close(out)
      print out
      next
    }
    inblock {
      body = $0
      # remove EXACTLY `depth` blockquote markers, preserving inner indentation
      for (i = 0; i < depth; i++) {
        if (match(body, /^[[:space:]]*>/)) {
          pre = substr(body, 1, RSTART - 1)
          rest = substr(body, RSTART + RLENGTH)
          sub(/^[[:space:]]?/, "", rest)
          body = pre rest
        }
      }
      print body >> out
      next
    }
    END {
      if (inblock) {
        printf "UNCLOSED FENCE starting at line %d\n", start > "/dev/stderr"
        exit 3
      }
    }
  ' "$src"
}

# ---------------------------------------------------------------------------
# Extractor self-test
# ---------------------------------------------------------------------------
# The extractor is the part of this script that can fail SILENTLY, and it has:
# the greedy-strip bug produced blocks that still parsed and still linted clean
# while no longer doing what the doc said, because a redirect eaten into an awk
# argument is valid bash. `bash -n` and shellcheck cannot see that class of
# defect -- verified by re-introducing the greedy strip and watching this whole
# sweep stay green. So the invariant gets asserted directly, against a fixture,
# before any real file is scanned. If someone "simplifies" the depth-counting
# strip, this is what stops them.
selftest() {
  local dir="$WORK/_selftest" out
  mkdir -p "$dir"
  # A blockquoted block (depth 1) whose body contains BOTH an inner-indented
  # line and a continuation-line output redirect starting with `>`.
  cat >"$dir/fixture.md" <<'FIXTURE'
> ```bash
> kubectl get pods \
>   | awk '{print $1}' \
>   > "$OUT/list.txt"
> if [ -s "$OUT/list.txt" ]; then
>   echo ok
> fi
> ```
FIXTURE
  out="$(extract "$dir/fixture.md" "$dir" "fixture")"
  [ -n "$out" ] || { echo "SELF-TEST FAILED: extractor produced no block from the fixture" >&2; exit 1; }
  # The redirect must survive as a redirect, on its own line.
  # shellcheck disable=SC2016  # the single quotes are the point: this is a grep
  # pattern that must match a LITERAL `$OUT`, not the value of $OUT.
  if ! grep -qE '^[[:space:]]+> "\$OUT/list.txt"$' "$out"; then
    echo "SELF-TEST FAILED: the extractor did not preserve a continuation-line" >&2
    echo "  output redirect. This is the greedy-blockquote-strip regression: it turns" >&2
    echo "  '> file' into an argument, so the block writes nothing and still parses." >&2
    echo "  Extracted body was:" >&2
    sed 's/^/    /' "$out" >&2
    exit 1
  fi
  # And the blockquote marker must be gone from ordinary lines.
  if grep -qE '^>' "$out"; then
    echo "SELF-TEST FAILED: blockquote markers survived extraction" >&2
    sed 's/^/    /' "$out" >&2
    exit 1
  fi
  # Depth 0 (an unquoted block) must be left completely alone.
  cat >"$dir/plain.md" <<'PLAIN'
```bash
echo a \
  > out.txt
```
PLAIN
  out="$(extract "$dir/plain.md" "$dir" "plain")"
  grep -qE '^[[:space:]]+> out\.txt$' "$out" || {
    echo "SELF-TEST FAILED: depth-0 block was altered" >&2; sed 's/^/    /' "$out" >&2; exit 1; }
  echo "extractor self-test: OK (blockquote depth stripped exactly; redirects preserved)"
}

# ---------------------------------------------------------------------------
# Placeholder substitution
# ---------------------------------------------------------------------------
# The runbooks are written for a human to fill in: `<release>`, `<node>`, and so
# on. Left alone, `<release>` is a shell redirect from a file named `release` and
# the block does not parse -- so a check that skipped this would report failures
# that are not real, get muted, and then cover nothing. Substituted with inert
# literals; `NS` is pre-seeded because every block references it.
substitute() {
  sed -e 's/<release>/RELEASE/g' \
      -e 's/<node>/NODE/g' \
      -e 's/<chart>/CHART/g' \
      -e 's/<values>/VALUES/g' \
      -e 's/<name>/NAME/g' \
      -e 's/<app>/APP/g' \
      -e 's/<fleet-ns>/FLEETNS/g' \
      -e 's/<consumer>/CONSUMER/g' \
      -e 's/<channel>/CHANNEL/g' \
      -e 's/<env>/ENV/g' \
      -e 's/<recorded-jobids>/1,2,3/g' \
      -e 's/<restore-drill-job>/JOB/g' \
      -e 's/<new>/NEW/g' \
      -e 's/<target>/TARGET/g' \
      -e 's/<[a-zA-Z][a-zA-Z0-9 ._,()\/-]*>/PLACEHOLDER/g' \
      "$1"
}

# ---------------------------------------------------------------------------
# Sweep
# ---------------------------------------------------------------------------
selftest

total=0
failed=0
have_shellcheck=0
if command -v shellcheck >/dev/null 2>&1; then
  have_shellcheck=1
  echo "shellcheck: $(shellcheck --version | awk '/^version:/ {print $2}')"
else
  echo "shellcheck: NOT FOUND on PATH -- running the parse check only." >&2
  echo "  This job installs a pinned shellcheck; if you see this in CI the install step" >&2
  echo "  did not put it on PATH and the lint half of this sweep is NOT running." >&2
fi

for t in "${TARGETS[@]}"; do
  slug="$(basename "$t" .md)"
  mkdir -p "$WORK/$slug"
  blocks="$(extract "$t" "$WORK/$slug" "$slug")"
  count="$(printf '%s' "$blocks" | grep -c . || true)"
  printf '%-34s %s bash block(s)\n' "$t" "$count"
  [ "$count" -eq 0 ] && continue
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    total=$((total + 1))
    prepared="$b.prepared"
    { echo '#!/usr/bin/env bash'; echo 'NS=NAMESPACE; export NS'; substitute "$b"; } > "$prepared"

    if ! err="$(bash -n "$prepared" 2>&1)"; then
      echo "::error file=$t::PARSE FAILURE in the bash block at $t:$(sed -E 's/.*\.L([0-9]+)\.sh.*/\1/' <<<"$b")"
      echo "  $err" | sed "s|$prepared|$t|g"
      failed=$((failed + 1))
      continue
    fi

    if [ "$have_shellcheck" -eq 1 ]; then
      # -S info rather than -S warning. Checked before choosing: all 40 blocks
      # are clean at -S info AND at -S style today, so tightening cost nothing,
      # and `info` buys the unquoted-expansion class (SC2086) -- which is a real
      # hazard in files where `$NS`, `$STATE_DIR` and `$WEB_HOST` are all
      # operator-supplied. Stopped short of `-S style` deliberately: style
      # findings are opinions, and a gate that argues about `${var//x/}` is a
      # gate people mute. The blocks that need word-splitting already carry
      # `# shellcheck disable=SC2086` with a reason, which is why -x is on.
      if ! err="$(shellcheck -S info -x "$prepared" 2>&1)"; then
        echo "::error file=$t::SHELLCHECK FAILURE in the bash block at $t:$(sed -E 's/.*\.L([0-9]+)\.sh.*/\1/' <<<"$b")"
        echo "$err" | sed "s|$prepared|$t|g" | sed 's/^/  /'
        failed=$((failed + 1))
      fi
    fi
  done <<<"$blocks"
done

# FAIL LOUDLY ON ZERO. A sweep that scans nothing passes, and "the guard quietly
# stopped covering anything" is the precise failure this file exists to prevent
# -- this branch shipped four separate assertions with that shape before anyone
# noticed. The floor is deliberately a real number, not `> 0`: these runbooks
# carry dozens of blocks, so a sudden drop to a handful means the extractor
# broke, not that someone tidied a doc.
MIN_BLOCKS=20
if [ "$total" -lt "$MIN_BLOCKS" ]; then
  echo "::error::extracted only $total bash block(s), expected at least $MIN_BLOCKS."
  echo "  Either the extractor is broken or the fences moved. A sweep that scans"
  echo "  nothing is the same defect it exists to prevent, so this is a failure."
  exit 1
fi

echo
if [ "$failed" -ne 0 ]; then
  echo "FAIL: $failed of $total bash block(s) did not parse or did not lint clean."
  exit 1
fi
echo "OK: $total bash block(s) across ${#TARGETS[@]} runbook(s) parse and lint clean."
