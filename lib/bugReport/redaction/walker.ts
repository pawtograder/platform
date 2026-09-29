/**
 * The redaction walker (spec package 3). It walks a frozen buffer's rrweb events in order and
 * replaces every detector hit with mask characters, in place, on a copy the caller owns.
 *
 * What it covers, and why each is needed although the recorder masks all text at record time:
 *   - text nodes: text under `data-report-unmask` (level `full`) is recorded as is. The walker
 *     keeps a node-id → text map replayed forward through FullSnapshots and mutations, and
 *     rebuilds the text of each block-level element from its inline descendants, so a name
 *     split across nodes (`<b>Jane</b> Doe`) matches as a whole, and text added later next to
 *     old text (a name inserted 30 s after load) is matched together with it. Spans map back to
 *     the node that holds each piece, even when that node was recorded in an earlier event.
 *   - attributes: `href` and `src` are never masked by rrweb, `data-*`, `id`, and `name` aren't
 *     either, and text attributes inside `data-report-unmask` stay readable.
 *   - input events (incremental source 5): inputs inside `data-report-unmask` are unmasked.
 *   - custom events: console messages, click descriptions, fetch URLs.
 *   - Meta `href`, the buffer's `urls`, and the document title (a `<title>` text node).
 *   - everything else that holds a string (stylesheet rules and the like), for completeness.
 * URLs are percent-decoded before matching, so `?q=Jane%20Doe` is caught.
 *
 * Redacted characters become `*`, keeping whitespace, like rrweb's own masking; in URLs every
 * character of the encoded range becomes `*`.
 */
import { RRWEB_EVENT_TYPE, type FrozenBuffer } from "../types";
import { linkedErrorsSince } from "../errorLinks";
import { mergeSpans, onWordBoundaries, type DetectorChain } from "./detectors";
import type { RemainingKind, RemainingString, Span } from "./types";
import { decodeUrlWithMap, toEncodedRange, urlDetectionText, type DecodedUrl } from "./urlText";

// rrweb-snapshot NodeType and IncrementalSource values used here.
const NODE_DOCUMENT = 0;
const NODE_ELEMENT = 2;
const NODE_TEXT = 3;
const SOURCE_MUTATION = 0;
const SOURCE_INPUT = 5;
const SOURCE_STYLE_SHEET_RULE = 8;
const SOURCE_ADOPTED_STYLE_SHEET = 15;
const SOURCE_STYLE_DECLARATION = 13;

/** Elements that don't start a new block of text. Everything else does. */
const INLINE_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "br",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "font",
  "i",
  "ins",
  "kbd",
  "label",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
  "wbr"
]);

/** Attributes shown to people; listed as "attribute" in `remaining`. Mirrors the recorder's list. */
const TEXT_ATTRIBUTES = new Set([
  "title",
  "alt",
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "aria-placeholder",
  "aria-roledescription",
  "placeholder",
  "label",
  "summary",
  "value",
  "download"
]);
const URL_ATTRIBUTES = new Set(["href", "src", "xlink:href", "action", "formaction", "srcset", "poster", "rr_src"]);
/** Class names and CSS: matched on word boundaries only, and never listed. */
const STRUCTURAL_ATTRIBUTES = new Set(["class", "style", "_cssText"]);
const INPUT_TAGS = new Set(["input", "textarea", "select", "option"]);

const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

type Holder = Record<string | number, unknown>;

/** A string field in the copied events that redactions are written into. */
type Target = {
  holder: Holder;
  key: string | number;
  /** `text` keeps whitespace when masking, like rrweb; `all` masks every character (URLs). */
  mode: "text" | "all";
  ranges: [number, number][];
};

type Piece = { start: number; end: number; target: Target; map?: DecodedUrl };

type Job = {
  text: string;
  /** Class names and CSS: only whole-word matches count. */
  bounded: boolean;
  /** Text ranges and where they live. For a block, separators between runs belong to no piece. */
  pieces: Piece[];
  /** Listed in `remaining` under this kind; null for strings people don't see. */
  kind: RemainingKind | null;
  /** Run only the click-to-redact detector (a URL's untouched text). */
  extraOnly?: boolean;
};

type NodeRecord = {
  id: number;
  type: number;
  tagName?: string;
  parent: number | null;
  children: number[];
  /** Text nodes: the current text and the field it came from. */
  text?: string;
  target?: Target;
  isStyle?: boolean;
};

type SerializedNode = {
  id: number;
  type: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SerializedNode[];
  textContent?: string | null;
  isStyle?: boolean;
};

type MutationData = {
  source: 0;
  texts?: { id: number; value: string | null }[];
  attributes?: { id: number; attributes: Record<string, unknown> }[];
  removes?: { parentId: number; id: number }[];
  adds?: { parentId: number; nextId: number | null; node: SerializedNode }[];
};

export type WalkResult = { remaining: RemainingString[]; textNodes: number; redactedSpans: number };

class Walker {
  private readonly nodes = new Map<number, NodeRecord>();
  private readonly jobs: Job[] = [];
  private readonly targets = new Map<Holder, Map<string | number, Target>>();
  private dirty = new Set<number>();
  textNodes = 0;

  target(holder: Holder, key: string | number, mode: "text" | "all" = "text"): Target {
    let byKey = this.targets.get(holder);
    if (!byKey) this.targets.set(holder, (byKey = new Map()));
    let t = byKey.get(key);
    if (!t) byKey.set(key, (t = { holder, key, mode, ranges: [] }));
    return t;
  }

  // --- string jobs ---------------------------------------------------------------------------

  /** Queue a plain string field. */
  string(holder: Holder, key: string | number, kind: RemainingKind | null, bounded = false): void {
    const text = holder[key];
    if (typeof text !== "string" || text.length === 0) return;
    const target = this.target(holder, key);
    this.jobs.push({ text, bounded, kind, pieces: [{ start: 0, end: text.length, target }] });
  }

  /**
   * Queue a URL field, masked in full where it matches. Detectors see it percent-decoded and
   * raw, with delimiters as spaces (`urlDetectionText`); the click-to-redact strings also see
   * it untouched, since review lists the URL as it is.
   */
  url(holder: Holder, key: string | number, kind: RemainingKind | null = "url"): void {
    const text = holder[key];
    if (typeof text !== "string" || text.length === 0) return;
    const target = this.target(holder, key, "all");
    const whole = [{ start: 0, end: text.length, target }];
    const map = decodeUrlWithMap(text);
    if (map.text !== text) {
      this.jobs.push({
        text: urlDetectionText(map.text),
        bounded: false,
        kind: null,
        pieces: [{ start: 0, end: map.text.length, target, map }]
      });
    }
    this.jobs.push({ text: urlDetectionText(text), bounded: false, kind, pieces: whole });
    this.jobs.push({ text, bounded: false, kind: null, pieces: whole, extraOnly: true });
  }

  /** Every string anywhere under `value`, for event data without a known shape. */
  deep(value: unknown, kind: RemainingKind | null, bounded: boolean, skipKeys?: ReadonlySet<string>): void {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === "string") this.string(value as unknown as Holder, i, kind, bounded);
        else if (value[i] && typeof value[i] === "object") this.deep(value[i], kind, bounded);
      }
    } else if (value && typeof value === "object") {
      const holder = value as Holder;
      for (const key of Object.keys(holder)) {
        if (skipKeys?.has(key)) continue;
        const v = holder[key];
        if (typeof v === "string") this.string(holder, key, kind, bounded);
        else if (v && typeof v === "object") this.deep(v, kind, bounded);
      }
    }
  }

  attribute(holder: Holder, name: string, tagName: string | undefined): void {
    const value = holder[name];
    if (value && typeof value === "object") {
      // A style mutation: {property: value | [value, priority] | false}.
      this.deep(value, null, true);
      return;
    }
    if (typeof value !== "string") return;
    const lower = name.toLowerCase();
    if (URL_ATTRIBUTES.has(lower)) this.url(holder, name);
    else if (STRUCTURAL_ATTRIBUTES.has(name)) this.string(holder, name, null, true);
    else if (lower === "value" && tagName && INPUT_TAGS.has(tagName)) this.string(holder, name, "input");
    else this.string(holder, name, TEXT_ATTRIBUTES.has(lower) ? "attribute" : null);
  }

  // --- the node map --------------------------------------------------------------------------

  private register(node: SerializedNode, parent: number | null): void {
    const rec: NodeRecord = {
      id: node.id,
      type: node.type,
      tagName: node.tagName?.toLowerCase(),
      parent,
      children: []
    };
    this.nodes.set(node.id, rec);
    if (node.type === NODE_ELEMENT && node.attributes) {
      for (const name of Object.keys(node.attributes)) this.attribute(node.attributes as Holder, name, rec.tagName);
    }
    if (node.type === NODE_TEXT) this.setText(rec, node as unknown as Holder, "textContent", node.isStyle === true);
    for (const child of node.childNodes ?? []) {
      rec.children.push(child.id);
      this.register(child, node.id);
    }
  }

  private parentTag(rec: NodeRecord): string | undefined {
    return rec.parent === null ? undefined : this.nodes.get(rec.parent)?.tagName;
  }

  /** Set a text node's text from `holder[key]`. Style and script text never joins a block. */
  private setText(rec: NodeRecord, holder: Holder, key: string, isStyle: boolean): void {
    const value = holder[key];
    rec.text = typeof value === "string" ? value : "";
    rec.target = undefined;
    const parentTag = this.parentTag(rec);
    rec.isStyle = isStyle || parentTag === "style";
    if (!rec.text) return;
    this.textNodes++;
    if (rec.isStyle) {
      this.string(holder, key, null, true);
      return;
    }
    if (parentTag === "script") return;
    rec.target = this.target(holder, key);
    this.markBlockOf(rec.id);
  }

  private isBlock(rec: NodeRecord): boolean {
    return rec.type === NODE_DOCUMENT || (rec.type === NODE_ELEMENT && !INLINE_TAGS.has(rec.tagName ?? ""));
  }

  /** The nearest block-level ancestor (or the topmost known ancestor). */
  private blockOf(id: number): number {
    let rec = this.nodes.get(id);
    if (!rec) return id;
    if (rec.type === NODE_ELEMENT && this.isBlock(rec)) return id;
    while (rec.parent !== null) {
      const parent = this.nodes.get(rec.parent);
      if (!parent) break;
      if (this.isBlock(parent)) return parent.id;
      rec = parent;
    }
    return rec.id;
  }

  private markBlockOf(id: number): void {
    this.dirty.add(this.blockOf(id));
  }

  private removeSubtree(id: number): void {
    const rec = this.nodes.get(id);
    if (!rec) return;
    this.nodes.delete(id);
    this.dirty.delete(id);
    for (const child of rec.children) this.removeSubtree(child);
  }

  fullSnapshot(node: SerializedNode): void {
    this.nodes.clear();
    this.dirty.clear();
    this.register(node, null);
    this.flush();
  }

  mutation(data: MutationData): void {
    for (const r of data.removes ?? []) {
      const rec = this.nodes.get(r.id);
      const parentId = rec?.parent ?? r.parentId;
      const parent = this.nodes.get(parentId);
      if (parent) {
        const i = parent.children.indexOf(r.id);
        if (i !== -1) parent.children.splice(i, 1);
        this.markBlockOf(parentId);
      }
      this.removeSubtree(r.id);
    }

    // Adds may arrive before the sibling they're inserted in front of; place them in passes.
    let pending = [...(data.adds ?? [])];
    const place = (add: (typeof pending)[number], force: boolean): boolean => {
      const parent = this.nodes.get(add.parentId);
      const nextKnown = add.nextId === null || this.nodes.has(add.nextId);
      if (!force && (!parent || !nextKnown)) return false;
      if (this.nodes.has(add.node.id)) this.detach(add.node.id);
      if (parent) {
        const at = add.nextId === null ? -1 : parent.children.indexOf(add.nextId);
        if (at === -1) parent.children.push(add.node.id);
        else parent.children.splice(at, 0, add.node.id);
      }
      this.register(add.node, parent ? parent.id : null);
      if (parent) this.markBlockOf(parent.id);
      return true;
    };
    while (pending.length > 0) {
      const next = pending.filter((add) => !place(add, false));
      if (next.length === pending.length) {
        for (const add of next) place(add, true);
        break;
      }
      pending = next;
    }

    for (const t of data.texts ?? []) {
      const rec = this.nodes.get(t.id);
      if (!rec) {
        this.textNodes++;
        this.string(t as unknown as Holder, "value", "text");
        continue;
      }
      this.setText(rec, t as unknown as Holder, "value", rec.isStyle === true);
    }

    for (const a of data.attributes ?? []) {
      const tagName = this.nodes.get(a.id)?.tagName;
      for (const name of Object.keys(a.attributes ?? {})) this.attribute(a.attributes as Holder, name, tagName);
    }
    this.flush();
  }

  private detach(id: number): void {
    const rec = this.nodes.get(id);
    const parent = rec?.parent != null ? this.nodes.get(rec.parent) : undefined;
    if (parent) {
      const i = parent.children.indexOf(id);
      if (i !== -1) parent.children.splice(i, 1);
    }
    this.removeSubtree(id);
  }

  /**
   * Queue jobs for each changed block: the text of its inline content, with a piece per text
   * node. Two versions: text nodes joined as they are, so a word split across elements
   * (`<b>Ja</b>ne`) is whole, and with a space wherever an inline element starts or ends,
   * so two adjacent links (often laid out apart by flex) don't read as one word. The spaced
   * version is the one listed in `remaining`.
   */
  private flush(): void {
    for (const blockId of this.dirty) {
      const block = this.nodes.get(blockId);
      if (!block) continue;
      const joined: Piece[] = [];
      const spaced: Piece[] = [];
      let joinedText = "";
      let spacedText = "";
      let boundary = false;
      const addText = (rec: NodeRecord) => {
        if (!rec.target || !rec.text) return;
        const text = rec.text;
        if (boundary && spacedText && !/\s$/.test(spacedText) && !/^\s/.test(text)) spacedText += " ";
        boundary = false;
        joined.push({ start: joinedText.length, end: joinedText.length + text.length, target: rec.target });
        spaced.push({ start: spacedText.length, end: spacedText.length + text.length, target: rec.target });
        joinedText += text;
        spacedText += text;
      };
      const visit = (rec: NodeRecord) => {
        for (const childId of rec.children) {
          const child = this.nodes.get(childId);
          if (!child) continue;
          if (child.type === NODE_TEXT) addText(child);
          else if (child.type === NODE_ELEMENT) {
            if (this.isBlock(child)) {
              if (joinedText && !joinedText.endsWith("\n")) joinedText += "\n";
              if (spacedText && !spacedText.endsWith("\n")) spacedText += "\n";
              boundary = false;
            } else {
              boundary = true;
              visit(child);
              boundary = true;
            }
          }
        }
      };
      if (block.type === NODE_TEXT) addText(block);
      else visit(block);
      if (joined.length === 0) continue;
      const kind: RemainingKind = block.tagName === "title" ? "title" : block.tagName === "textarea" ? "input" : "text";
      this.jobs.push({ text: spacedText, bounded: false, pieces: spaced, kind });
      if (joinedText !== spacedText) this.jobs.push({ text: joinedText, bounded: false, pieces: joined, kind: null });
    }
    this.dirty = new Set();
  }

  // --- detection and masking -----------------------------------------------------------------

  async detect(chain: DetectorChain): Promise<void> {
    const cache = new Map<string, Span[]>();
    const keyOf = (job: Job) => (job.extraOnly ? "x" : job.bounded ? "b" : "t") + job.text;
    const unique: Job[] = [];
    for (const job of this.jobs) {
      if (!HAS_WORD_CHAR.test(job.text)) continue;
      const key = keyOf(job);
      if (cache.has(key)) continue;
      const spans: Span[] = chain.extra(job.text);
      if (!job.extraOnly) {
        for (const d of chain.sync) spans.push(...d(job.text));
        unique.push(job);
      }
      cache.set(key, spans);
    }
    for (const d of chain.async) {
      for (const job of unique) cache.get(keyOf(job))!.push(...(await d(job.text)));
    }
    for (const job of this.jobs) {
      let spans = cache.get(keyOf(job));
      if (!spans || spans.length === 0) continue;
      if (job.bounded) spans = onWordBoundaries(job.text, spans);
      for (const [start, end] of mergeSpans(spans)) {
        for (const p of job.pieces) {
          const a = Math.max(start, p.start);
          const b = Math.min(end, p.end);
          if (a >= b) continue;
          p.target.ranges.push(p.map ? toEncodedRange(p.map, a - p.start, b - p.start) : [a - p.start, b - p.start]);
        }
      }
    }
  }

  /** Writes the masks into the events. Returns the number of merged ranges written. */
  apply(): number {
    let count = 0;
    for (const byKey of this.targets.values()) {
      for (const t of byKey.values()) {
        if (t.ranges.length === 0) continue;
        const value = t.holder[t.key];
        if (typeof value !== "string") continue;
        const merged = mergeSpans(t.ranges.map(([start, end]) => ({ start, end })));
        let out = "";
        let at = 0;
        for (const [start, end] of merged) {
          out += value.slice(at, start);
          const hit = value.slice(start, end);
          out += t.mode === "all" ? "*".repeat(hit.length) : hit.replace(/\S/g, "*");
          at = end;
        }
        t.holder[t.key] = out + value.slice(at);
        count += merged.length;
      }
    }
    return count;
  }

  /** The human-readable strings left, from the final (masked) fields. */
  remaining(): RemainingString[] {
    const groups = new Map<string, RemainingString>();
    for (const job of this.jobs) {
      if (!job.kind) continue;
      let value = "";
      let at = 0;
      for (const p of job.pieces) {
        // Separators between runs of a block (and nothing else) sit between pieces.
        if (p.start > at) value += job.text.slice(at, p.start);
        // Each piece covers its whole field, and masking keeps lengths, so the final field is the piece.
        const current = p.target.holder[p.target.key];
        if (typeof current === "string") value += current;
        at = p.end;
      }
      // One entry per run of inline text: a nested block (the "\n" separators) starts a new one.
      for (const line of value.split("\n")) {
        const trimmed = line.trim();
        if (!HAS_WORD_CHAR.test(trimmed)) continue;
        const key = `${job.kind}\u0000${trimmed}`;
        const existing = groups.get(key);
        if (existing) existing.count++;
        else groups.set(key, { value: trimmed, kind: job.kind, count: 1 });
      }
    }
    const order: RemainingKind[] = ["text", "title", "attribute", "input", "url", "console", "breadcrumb"];
    return [...groups.values()].sort(
      (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.count - a.count || a.value.localeCompare(b.value)
    );
  }
}

const BREADCRUMB_SKIP_KEYS = new Set(["category", "level", "timestamp", "type", "message", "data"]);
const FETCH_DATA_SKIP_KEYS = new Set(["url", "method"]);
const CSS_SOURCES = new Set([SOURCE_STYLE_SHEET_RULE, SOURCE_STYLE_DECLARATION, SOURCE_ADOPTED_STYLE_SHEET]);

function walkEvent(w: Walker, event: { type: number; data: unknown }): void {
  const data = event.data as Holder;
  if (!data || typeof data !== "object") return;
  switch (event.type) {
    case RRWEB_EVENT_TYPE.Meta:
      w.url(data, "href");
      return;
    case RRWEB_EVENT_TYPE.FullSnapshot:
      w.fullSnapshot(data.node as SerializedNode);
      return;
    case RRWEB_EVENT_TYPE.IncrementalSnapshot: {
      const source = data.source as number;
      if (source === SOURCE_MUTATION) w.mutation(data as unknown as MutationData);
      else if (source === SOURCE_INPUT) w.string(data, "text", "input");
      else w.deep(data, null, CSS_SOURCES.has(source));
      return;
    }
    case RRWEB_EVENT_TYPE.Custom: {
      const payload = data.payload as Holder | undefined;
      if (data.tag === "breadcrumb" && payload && typeof payload === "object") {
        w.string(payload, "message", payload.category === "console" ? "console" : "breadcrumb");
        const inner = payload.data as Holder | undefined;
        if (inner && typeof inner === "object") {
          w.url(inner, "url");
          w.deep(inner, null, false, FETCH_DATA_SKIP_KEYS);
        }
        w.deep(payload, null, false, BREADCRUMB_SKIP_KEYS);
      } else {
        w.deep(payload, "breadcrumb", false);
      }
      return;
    }
    default:
      w.deep(data, null, false);
  }
}

/**
 * Drops whole segments from the front so the buffer spans at most `keepLastMs` (always keeping
 * the newest segment). Every segment starts with Meta + FullSnapshot, so the result does too.
 * Shares segment objects with the input.
 */
export function keepLast(buffer: FrozenBuffer, keepLastMs: number | undefined): FrozenBuffer {
  if (!keepLastMs || keepLastMs <= 0 || buffer.segments.length <= 1) return buffer;
  const cutoff = buffer.endTimestamp - keepLastMs;
  let first = buffer.segments.findIndex((s) => s.startTimestamp >= cutoff);
  if (first === -1) first = buffer.segments.length - 1;
  if (first === 0) return buffer;
  const segments = buffer.segments.slice(first);
  // `urls` is in visit order without duplicates. Keep it from the URL the window starts on;
  // when that URL was also visited earlier, this keeps a few URLs from before the window.
  const startHref = (segments[0].events[0]?.data as { href?: unknown } | undefined)?.href;
  const at = typeof startHref === "string" ? buffer.urls.indexOf(startHref) : -1;
  // Link only the errors inside the new window. A buffer without timestamps keeps its ids.
  const linked = buffer.errors ? linkedErrorsSince(buffer.errors, segments[0].startTimestamp) : null;
  return {
    ...buffer,
    ...(linked ?? {}),
    segments,
    startTimestamp: segments[0].startTimestamp,
    urls: at === -1 ? buffer.urls : buffer.urls.slice(at),
    size: segments.reduce((n, s) => n + s.size, 0)
  };
}

/**
 * Redacts `buffer` in place (the caller passes a copy it owns) and returns what's left for the
 * review list. Apply `keepLast` first.
 */
export async function walkBuffer(buffer: FrozenBuffer, chain: DetectorChain): Promise<WalkResult> {
  const w = new Walker();
  for (const segment of buffer.segments) {
    for (const event of segment.events) walkEvent(w, event as { type: number; data: unknown });
  }
  const urls = buffer.urls as unknown as Holder;
  for (let i = 0; i < buffer.urls.length; i++) w.url(urls, i);
  await w.detect(chain);
  const redactedSpans = w.apply();
  return { remaining: w.remaining(), textNodes: w.textNodes, redactedSpans };
}
