import { getTaintSet, TAINT_KINDS, type TaintSet } from "../taint";
import type { TaintSnapshot } from "./types";

/**
 * The taint set as serializable match patterns for the worker, one entry per distinct pattern.
 * The set expands every value into its variants when it is added (`matchPatterns`: first and last
 * tokens, "Last, First", email local part, free text per line), so `values()` already holds the
 * normalized patterns; this only flattens them.
 */
export function taintSnapshot(set: TaintSet = getTaintSet()): TaintSnapshot {
  const values = set.values();
  const seen = new Set<string>();
  const out: TaintSnapshot = [];
  for (const kind of TAINT_KINDS) {
    for (const pattern of values[kind] ?? []) {
      if (seen.has(pattern)) continue;
      seen.add(pattern);
      out.push({ kind, pattern });
    }
  }
  return out;
}
