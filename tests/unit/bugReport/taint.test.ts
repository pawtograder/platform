/**
 * The taint set (package 2): variant expansion at add time, free text per line, dedupe, the
 * pattern-length cut, and the taint block reader.
 */
import { createTaintSet, MAX_PATTERN_LENGTH, readTaintBlocks, TAINT_BLOCK_ID } from "@/lib/bugReport/taint";

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

  it("splits free text into lines and cuts long lines", () => {
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
