/**
 * The taint set (package 2): variant expansion at add time, free text per line, dedupe, the
 * pattern-length cut, and the taint block reader.
 */
import { taintSnapshot } from "@/lib/bugReport/redaction/taintSnapshot";
import {
  chunkPattern,
  createTaintSet,
  MAX_PATTERN_LENGTH,
  readTaintBlocks,
  TAINT_BLOCK_ID
} from "@/lib/bugReport/taint";

/** About 4 MB of code-like text in 18-character lines, like a large `submission_files.contents`. */
function bigSubmission(): string {
  let file = "";
  for (let i = 0; i < 210_000; i++) file += `  x${i} = f(y${i});\n`;
  return file;
}

describe("taint set", () => {
  it("expands names into variants and normalizes", () => {
    const set = createTaintSet();
    set.add("name", "Jane Q. Canary");
    expect(set.has("JANE  q. canary")).toBe(true);
    expect(set.has("Canary, Jane")).toBe(true);
    expect(set.has("Jane")).toBe(true);
    expect(set.has("Q.")).toBe(false);
    expect(set.values().name.sort()).toEqual(
      ["jane q. canary", "jane", "canary", "jane canary", "canary, jane", "canary, jane q."].sort()
    );
  });

  it("adds an email and its local part, and a handle as is", () => {
    const set = createTaintSet();
    set.add("email", "zorvik.canary@example.test");
    set.add("handle", "Octo-Canary42");
    expect(set.values().email.sort()).toEqual(["zorvik.canary", "zorvik.canary@example.test"]);
    expect(set.has("octo-canary42")).toBe(true);
  });

  it("drops values under 3 characters and initials", () => {
    const set = createTaintSet();
    set.add("name", "Al");
    set.add("name", "J.D.");
    set.add("handle", "ab");
    expect(set.size).toBe(0);
  });

  it("splits free text into lines and chunks long lines", () => {
    const set = createTaintSet();
    set.add("free_text", "First line of a post\n\nSecond line");
    expect(set.has("first line of a post")).toBe(true);
    expect(set.has("second line")).toBe(true);
    const long = "x".repeat(MAX_PATTERN_LENGTH + 100);
    set.add("free_text", long);
    expect(set.values().free_text.some((p) => p.length === MAX_PATTERN_LENGTH)).toBe(true);
  });

  it("dedupes repeats and patterns shared across kinds", () => {
    const set = createTaintSet();
    set.add("name", "Zorvik Canary");
    const size = set.size;
    set.add("name", "Zorvik Canary");
    set.add("handle", "zorvik");
    expect(set.size).toBe(size);
    const stats = set.stats();
    expect(stats.patterns).toBe(size);
    expect(stats.byKind.name).toBe(size);
    expect(stats.saturated).toBe(false);
  });

  it("ignores grades and unknown kinds", () => {
    const set = createTaintSet();
    set.add("grade" as never, "87.31");
    expect(set.size).toBe(0);
  });

  it("clears", () => {
    const set = createTaintSet();
    set.add("name", "Zorvik Canary");
    set.clear();
    expect(set.size).toBe(0);
    set.add("name", "Zorvik Canary");
    expect(set.size).toBeGreaterThan(0);
  });
});

describe("chunkPattern", () => {
  /** Offsets of each chunk in `line`, found left to right. */
  function spans(line: string, chunks: string[]): [number, number][] {
    let from = 0;
    return chunks.map((c) => {
      const at = line.indexOf(c, from);
      expect(at).toBeGreaterThanOrEqual(0);
      from = at + 1;
      return [at, at + c.length];
    });
  }

  it("covers a long line with overlapping chunks cut on word boundaries", () => {
    const line = ("secretpost " + "alpha beta gamma delta ".repeat(30) + "tailcanary end").trim();
    expect(line.length).toBe(715);
    const chunks = chunkPattern(line);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_PATTERN_LENGTH);
    const ranges = spans(line, chunks);
    expect(ranges[0][0]).toBe(0);
    expect(ranges[ranges.length - 1][1]).toBe(line.length);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBeLessThan(ranges[i - 1][1]);
    // Cut on word boundaries: every chunk starts and ends at a whole word.
    for (const [start, end] of ranges) {
      expect(start === 0 || line[start - 1] === " ").toBe(true);
      expect(end === line.length || line[end] === " ").toBe(true);
    }
  });

  it("covers a long line with no spaces", () => {
    let line = "";
    for (let i = 0; line.length < 1300; i++) line += String(i);
    const ranges = spans(line, chunkPattern(line));
    expect(ranges[ranges.length - 1][1]).toBe(line.length);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBeLessThan(ranges[i - 1][1]);
  });

  it("leaves short patterns whole", () => {
    expect(chunkPattern("a short line")).toEqual(["a short line"]);
  });
});

describe("taint set budgets and incremental adds", () => {
  it("keeps names, emails, and handles when free text fills its budget, and reports saturation", () => {
    const set = createTaintSet();
    set.add("free_text", bigSubmission());
    set.add("name", "Zorvik Quellmar");
    set.add("email", "kvounder@example.test");
    expect(set.has("Zorvik Quellmar")).toBe(true);
    expect(set.has("Quellmar, Zorvik")).toBe(true);
    expect(set.has("kvounder@example.test")).toBe(true);
    const stats = set.stats();
    expect(stats.saturated).toBe(true);
    expect(stats.droppedIdentity).toBe(0);
    expect(set.isSaturated()).toBe(true);
    expect(createTaintSet().isSaturated()).toBe(false);
  });

  it("queues a large free-text add and drains it in short slices", () => {
    const callbacks: (() => void)[] = [];
    const timeout = jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
      callbacks.push(fn);
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
    try {
      const set = createTaintSet();
      const file = bigSubmission();
      let started = performance.now();
      set.add("free_text", file);
      expect(performance.now() - started).toBeLessThan(50);
      // Run the first few drain steps: each stays well under a long task.
      for (let step = 0; step < 3; step++) {
        const next = callbacks.shift();
        expect(next).toBeDefined();
        started = performance.now();
        next!();
        expect(performance.now() - started).toBeLessThan(50);
      }
      expect(callbacks.length).toBe(1);
      // A read drains the rest at once, so the snapshot has every line.
      const patterns = taintSnapshot(set).map((p) => p.pattern);
      expect(patterns).toContain("x0 = f(y0);");
      expect(patterns).toContain("x9999 = f(y9999);");
    } finally {
      timeout.mockRestore();
    }
  });

  it("drains queued free text before a snapshot", () => {
    const set = createTaintSet();
    set.add("free_text", "A queued post naming Quellmar\nand a second line");
    expect(taintSnapshot(set)).toEqual(
      expect.arrayContaining([
        { kind: "free_text", pattern: "a queued post naming quellmar" },
        { kind: "free_text", pattern: "and a second line" }
      ])
    );
  });

  it("drops queued free text on clear", () => {
    const set = createTaintSet();
    set.add("free_text", "Cleared before it drained");
    set.clear();
    expect(set.size).toBe(0);
  });
});

describe("readTaintBlocks", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("reads every kind, with variants, and skips malformed blocks", () => {
    document.body.innerHTML = `
      <script type="application/json" id="${TAINT_BLOCK_ID}">{"v":1,"values":{"name":["Quillon Canary"],"email":["q.canary@example.test"],"free_text":["An answer naming Quillon"]}}</script>
      <script type="application/json" id="${TAINT_BLOCK_ID}">{not json</script>
      <script type="application/json" id="${TAINT_BLOCK_ID}">{"v":2,"values":{"name":["Other Person"]}}</script>`;
    const set = createTaintSet();
    readTaintBlocks(document, set);
    expect(set.has("Canary, Quillon")).toBe(true);
    expect(set.has("q.canary")).toBe(true);
    expect(set.has("an answer naming quillon")).toBe(true);
    expect(set.has("Other Person")).toBe(false);
  });
});
