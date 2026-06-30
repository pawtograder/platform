#!/usr/bin/env python3
"""Compare two directories of Argos screenshots for pixel diffs.

Usage:
  ./scripts/e2e-diff-screenshots.py screenshots-run1 screenshots-run2

Reports:
  - screenshots present in one run but not the other
  - screenshots that differ in size or content
  - per-test summary: NUM_DIFFERING_SCREENSHOTS / TOTAL
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from collections import defaultdict
from pathlib import Path


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def collect(root: Path) -> dict[str, Path]:
    out: dict[str, Path] = {}
    for p in root.rglob("*.png"):
        key = str(p.relative_to(root))
        out[key] = p
    return out


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    a_root = Path(sys.argv[1])
    b_root = Path(sys.argv[2])
    if not a_root.is_dir() or not b_root.is_dir():
        print("Both arguments must be directories.", file=sys.stderr)
        return 2

    a = collect(a_root)
    b = collect(b_root)

    only_a = sorted(set(a) - set(b))
    only_b = sorted(set(b) - set(a))
    in_both = sorted(set(a) & set(b))

    differing = []
    for key in in_both:
        ap = a[key]
        bp = b[key]
        if ap.stat().st_size != bp.stat().st_size:
            differing.append(key)
            continue
        if file_hash(ap) != file_hash(bp):
            differing.append(key)

    by_test = defaultdict(lambda: {"total": 0, "diff": 0})
    for key in in_both:
        test = key.split("/", 1)[0]
        by_test[test]["total"] += 1
        if key in differing:
            by_test[test]["diff"] += 1

    print(f"Common screenshots: {len(in_both)}")
    print(f"Different:          {len(differing)}")
    print(f"Only in {a_root}:  {len(only_a)}")
    print(f"Only in {b_root}:  {len(only_b)}")
    print()

    if differing:
        print("=== Differing screenshots ===")
        for k in differing:
            print(f"  {k}")
        print()

    flaky_tests = sorted(
        ((t, c["diff"], c["total"]) for t, c in by_test.items() if c["diff"]),
        key=lambda x: -x[1],
    )
    if flaky_tests:
        print("=== Tests with screenshot diffs ===")
        for t, diff, total in flaky_tests:
            print(f"  {t}: {diff}/{total}")

    out = {
        "common": len(in_both),
        "differing": differing,
        "only_a": only_a,
        "only_b": only_b,
        "by_test": dict(by_test),
    }
    with open("screenshot-diff-report.json", "w") as f:
        json.dump(out, f, indent=2)
    print("\nWrote screenshot-diff-report.json")
    return 1 if differing or only_a or only_b else 0


if __name__ == "__main__":
    sys.exit(main())
