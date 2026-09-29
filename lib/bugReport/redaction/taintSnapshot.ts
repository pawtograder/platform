import { getTaintSet, type TaintKind, type TaintSet } from "../taint";
import { matchPatterns } from "../variants";
import type { TaintSnapshot } from "./types";

const KINDS: readonly TaintKind[] = ["name", "email", "handle"];

/**
 * The taint set as serializable match patterns for the worker: every value expanded into its
 * variants (`matchPatterns`: first and last tokens, "Last, First", email local part, ...), one
 * entry per distinct pattern. Uses only `TaintSet.values()`, so it works with whatever the
 * ingest points put in the set.
 */
export function taintSnapshot(set: TaintSet = getTaintSet()): TaintSnapshot {
  const values = set.values();
  const seen = new Set<string>();
  const out: TaintSnapshot = [];
  for (const kind of KINDS) {
    for (const value of values[kind] ?? []) {
      for (const pattern of matchPatterns(value, kind)) {
        if (seen.has(pattern)) continue;
        seen.add(pattern);
        out.push({ kind, pattern });
      }
    }
  }
  return out;
}
