/**
 * Parsers for the NUL-delimited plumbing output the engine reads: `ls-tree -r -t -z`,
 * `diff-tree -r -z --raw` and `diff-tree -r -z --numstat` (docs/handout-sync-git-worker.md §5.3,
 * §5.4).
 *
 * Every parser works on raw bytes. A git path is a byte string, not text, and decoding a whole
 * listing as UTF-8 first would turn every invalid byte into U+FFFD, so two different paths could
 * come out as the same JS string and one file's classification would be read for another's.
 * Paths are decoded one at a time with a fatal decoder, which is injective on the paths it
 * accepts. The caller decides what a path that fails to decode means: terminal on the handout
 * side (§5.3), irrelevant on the student side.
 */
import type { TreeEntry, TreeEntryType } from "../syncConflictGuard.ts";

const NUL = 0x00;
const TAB = 0x09;

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const ascii = new TextDecoder("ascii");

/** The path as a JS string, or `null` when its bytes are not valid UTF-8. */
export function decodePath(bytes: Uint8Array): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * A lossless string key for a byte path, one char per byte. Used to join the raw and numstat
 * listings of the same diff before any path is decoded.
 */
function byteKey(bytes: Uint8Array): string {
  let key = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    key += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  return key;
}

/**
 * A printable rendering of a byte path for logs and error messages, in the style of git's own
 * C-quoting: printable ASCII as is, everything else (and `\` and `"`) as an octal escape.
 */
export function escapePath(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    if (b >= 0x20 && b < 0x7f && b !== 0x5c && b !== 0x22) out += String.fromCharCode(b);
    else out += `\\${b.toString(8).padStart(3, "0")}`;
  }
  return `"${out}"`;
}

/** Splits `-z` output into records. A trailing NUL ends the last record, it does not start one. */
function splitNul(bytes: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === NUL) {
      records.push(bytes.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < bytes.length) records.push(bytes.subarray(start));
  return records;
}

class GitOutputParseError extends Error {
  constructor(what: string, detail: string) {
    super(`unexpected ${what} output: ${detail}`);
    this.name = "GitOutputParseError";
  }
}

export interface ParsedTree {
  /** Every entry whose path is valid UTF-8, keyed by that path. Trees included (`-t`). */
  entries: Map<string, TreeEntry>;
  /** How many entries were left out because their path is not valid UTF-8. */
  nonUtf8Paths: number;
}

const TREE_TYPES: ReadonlySet<string> = new Set<TreeEntryType>(["blob", "tree", "commit"]);

/**
 * `ls-tree -r -t -z --full-tree`: `<mode> SP <type> SP <oid> TAB <path> NUL` per entry.
 *
 * An entry whose path is not valid UTF-8 is counted and dropped rather than decoded lossily.
 * Dropping it cannot make another path read as absent: every path the engine looks up is a
 * decoded handout path, so it is valid UTF-8 and can never equal those bytes, and the same holds
 * for its ancestors.
 */
export function parseLsTree(bytes: Uint8Array): ParsedTree {
  const entries = new Map<string, TreeEntry>();
  let nonUtf8Paths = 0;
  for (const record of splitNul(bytes)) {
    const tab = record.indexOf(TAB);
    if (tab < 0) throw new GitOutputParseError("ls-tree", "record without a tab");
    const [mode, type, sha] = ascii.decode(record.subarray(0, tab)).split(" ");
    if (!mode || !TREE_TYPES.has(type) || !/^[0-9a-f]{40}$/.test(sha ?? "")) {
      throw new GitOutputParseError("ls-tree", JSON.stringify(ascii.decode(record.subarray(0, tab))));
    }
    const path = decodePath(record.subarray(tab + 1));
    if (path === null) {
      nonUtf8Paths++;
      continue;
    }
    entries.set(path, { sha, type: type as TreeEntryType, mode });
  }
  return { entries, nonUtf8Paths };
}

/** One record of `diff-tree --raw`. Modes and oids are `null` on the side where the path is absent. */
export interface RawDiffRecord {
  status: "A" | "M" | "D" | "T";
  oldMode: string | null;
  newMode: string | null;
  oldOid: string | null;
  newOid: string | null;
  /** The path's raw bytes, undecoded. */
  pathBytes: Uint8Array;
  /** Lossless key for joining with numstat. */
  key: string;
}

const ZERO_MODE = "000000";
const ZERO_OID = "0".repeat(40);

/**
 * `diff-tree -r -z --no-renames --raw`: `:<old mode> <new mode> <old oid> <new oid> <status> NUL
 * <path> NUL` per change. With `--no-renames` no record carries a score or a second path, so a
 * status outside A, D, M and T means the invocation changed under us, and is an error rather than
 * something to guess at.
 */
export function parseDiffTreeRaw(bytes: Uint8Array): RawDiffRecord[] {
  const out: RawDiffRecord[] = [];
  const fields = splitNul(bytes);
  for (let i = 0; i < fields.length; i += 2) {
    const meta = ascii.decode(fields[i]);
    const pathBytes = fields[i + 1];
    if (!meta.startsWith(":") || pathBytes === undefined) {
      throw new GitOutputParseError("diff-tree --raw", JSON.stringify(meta.slice(0, 120)));
    }
    const [oldMode, newMode, oldOid, newOid, status] = meta.slice(1).split(" ");
    if (status !== "A" && status !== "M" && status !== "D" && status !== "T") {
      throw new GitOutputParseError("diff-tree --raw", `status ${JSON.stringify(status)}`);
    }
    out.push({
      status,
      oldMode: oldMode === ZERO_MODE ? null : oldMode,
      newMode: newMode === ZERO_MODE ? null : newMode,
      oldOid: oldOid === ZERO_OID ? null : oldOid,
      newOid: newOid === ZERO_OID ? null : newOid,
      pathBytes,
      key: byteKey(pathBytes)
    });
  }
  return out;
}

/**
 * `diff-tree -r -z --no-renames --numstat`: `<added> TAB <deleted> TAB <path> NUL`. Returns, per
 * path key, whether git called the change binary (`-` in both columns).
 */
export function parseNumstatBinary(bytes: Uint8Array): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const record of splitNul(bytes)) {
    const first = record.indexOf(TAB);
    const second = first < 0 ? -1 : record.indexOf(TAB, first + 1);
    if (second < 0) throw new GitOutputParseError("diff-tree --numstat", "record without two tabs");
    const added = ascii.decode(record.subarray(0, first));
    const deleted = ascii.decode(record.subarray(first + 1, second));
    out.set(byteKey(record.subarray(second + 1)), added === "-" && deleted === "-");
  }
  return out;
}

/** The fields of a `cat-file commit` header the engine needs (§5.7). */
export interface CommitHeader {
  tree: string;
  /** Committer date in git's raw form, `<unix seconds> <+|-HHMM>`. */
  committerDate: string;
}

/**
 * Reads `tree` and the committer date out of a raw commit object. Only the header is examined:
 * it ends at the first blank line, and the message after it is never decoded.
 */
export function parseCommitHeader(bytes: Uint8Array): CommitHeader {
  let end = bytes.length;
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) {
      end = i;
      break;
    }
  }
  let tree: string | null = null;
  let committerDate: string | null = null;
  for (const line of ascii.decode(bytes.subarray(0, end)).split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5);
    if (line.startsWith("committer ")) {
      // `committer Name <email> 1700000000 +0000`. The name can hold spaces but not `>`.
      const m = /> (\d+ [+-]\d{4})$/.exec(line);
      if (m) committerDate = m[1];
    }
  }
  if (!tree || !/^[0-9a-f]{40}$/.test(tree) || !committerDate) {
    throw new GitOutputParseError("cat-file commit", "missing tree or committer date");
  }
  return { tree, committerDate };
}

/** The first space-free token of trimmed ASCII output, such as `cat-file -s`. */
export function firstToken(bytes: Uint8Array): string {
  return ascii.decode(bytes).trim().split(/\s/)[0] ?? "";
}
