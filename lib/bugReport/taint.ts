/**
 * The taint set: values from classified sources that the redaction pass removes from recorded
 * text. It lasts one page load (module state; a full load starts empty).
 *
 * Package 1 provides only this hook point. Package 2 fills it from the ingest points (fetch
 * wrapper, TableController, realtime, taint block, auth session), adds name variants, and
 * builds the matcher.
 */

/** The kinds a taint value can have. Grades and free text are blocked structurally instead. */
export type TaintKind = "name" | "email" | "handle";

export interface TaintSet {
  add(kind: TaintKind, value: string): void;
  has(value: string): boolean;
  /** Every value, grouped by kind. */
  values(): Record<TaintKind, string[]>;
  clear(): void;
}

class SimpleTaintSet implements TaintSet {
  private readonly byKind: Record<TaintKind, Set<string>> = {
    name: new Set(),
    email: new Set(),
    handle: new Set()
  };

  add(kind: TaintKind, value: string): void {
    if (typeof value !== "string") return;
    const v = value.trim();
    if (v.length === 0) return;
    this.byKind[kind]?.add(v);
  }

  has(value: string): boolean {
    const v = value.trim();
    return this.byKind.name.has(v) || this.byKind.email.has(v) || this.byKind.handle.has(v);
  }

  values(): Record<TaintKind, string[]> {
    return {
      name: [...this.byKind.name],
      email: [...this.byKind.email],
      handle: [...this.byKind.handle]
    };
  }

  clear(): void {
    this.byKind.name.clear();
    this.byKind.email.clear();
    this.byKind.handle.clear();
  }
}

let pageTaintSet: TaintSet | undefined;

/** This page load's taint set. */
export function getTaintSet(): TaintSet {
  pageTaintSet ??= new SimpleTaintSet();
  return pageTaintSet;
}

export const TAINT_BLOCK_ID = "report-taint";

/** The JSON inside `<script type="application/json" id="report-taint">` (spec section 4.3). */
export type TaintBlockPayload = {
  v: 1;
  values: Partial<Record<TaintKind, string[]>>;
};

const TAINT_KINDS: readonly TaintKind[] = ["name", "email", "handle"];

/** Read every taint block in `doc` into `set`. Malformed blocks are skipped. */
export function readTaintBlocks(doc: Document, set: TaintSet): void {
  for (const el of Array.from(doc.querySelectorAll(`script#${TAINT_BLOCK_ID}[type="application/json"]`))) {
    try {
      const parsed = JSON.parse(el.textContent ?? "") as Partial<TaintBlockPayload>;
      if (parsed?.v !== 1 || !parsed.values || typeof parsed.values !== "object") continue;
      for (const kind of TAINT_KINDS) {
        const list = parsed.values[kind];
        if (Array.isArray(list)) for (const value of list) if (typeof value === "string") set.add(kind, value);
      }
    } catch {
      // A malformed block adds nothing; the regex backstop still runs.
    }
  }
}
