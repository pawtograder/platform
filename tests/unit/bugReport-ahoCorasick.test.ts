/**
 * @jest-environment node
 */
import { AhoCorasick, MIN_MATCH_LENGTH, normalizeForMatch } from "@/lib/bugReport/ahoCorasick";
import { variants } from "@/lib/bugReport/variants";

function found(ac: AhoCorasick<string>, text: string) {
  return ac.search(text).map((m) => ({ text: text.slice(m.start, m.end), values: [...m.values] }));
}

describe("normalizeForMatch", () => {
  it("lower-cases, collapses whitespace, and maps back to original offsets", () => {
    const input = "Jane \n\t DOE";
    const n = normalizeForMatch(input);
    expect(n.text).toBe("jane doe");
    // The single space covers the whole whitespace run.
    expect(input.slice(n.starts[4], n.ends[4])).toBe(" \n\t ");
    expect(input.slice(n.starts[5], n.ends[7])).toBe("DOE");
  });

  it("keeps offsets right when lower-casing changes length", () => {
    const input = "xİstanbul";
    const n = normalizeForMatch(input);
    expect(n.text.length).toBe(input.length + 1);
    expect(n.starts[n.text.length - 1]).toBe(input.length - 1);
  });
});

describe("AhoCorasick", () => {
  it("finds every pattern, including overlaps and repeats", () => {
    const ac = new AhoCorasick<string>([
      ["he", "short"],
      ["she", "a"],
      ["hers", "b"],
      ["his", "c"]
    ]);
    const hits = found(ac, "ushers his hers");
    expect(hits).toEqual([
      { text: "she", values: ["a"] },
      { text: "hers", values: ["b"] },
      { text: "his", values: ["c"] },
      { text: "hers", values: ["b"] }
    ]);
  });

  it("matches case- and whitespace-insensitively and reports original spans", () => {
    const ac = new AhoCorasick<string>([["Jane Doe", "p1"]]);
    const text = "Hello JANE\n   doe!";
    const [m] = ac.search(text);
    expect(text.slice(m.start, m.end)).toBe("JANE\n   doe");
  });

  it(`drops patterns shorter than ${MIN_MATCH_LENGTH} characters`, () => {
    const ac = new AhoCorasick<string>();
    expect(ac.add("JD", "initials")).toBe(false);
    expect(ac.add(" A ", "grade")).toBe(false);
    expect(ac.add("Ann", "name")).toBe(true);
    expect(ac.size).toBe(1);
    expect(ac.test("JD got an A")).toBe(false);
  });

  it("merges values for patterns that normalize the same", () => {
    const ac = new AhoCorasick<number>([
      ["Doe", 1],
      ["DOE", 2]
    ]);
    expect(ac.size).toBe(1);
    expect(ac.search("doe")[0].values).toEqual([1, 2]);
  });

  it("handles patterns added after a search", () => {
    const ac = new AhoCorasick<string>([["alpha", "a"]]);
    expect(ac.test("beta")).toBe(false);
    ac.add("beta", "b");
    expect(found(ac, "alpha beta")).toEqual([
      { text: "alpha", values: ["a"] },
      { text: "beta", values: ["b"] }
    ]);
  });

  it("agrees with a naive scan on random input", () => {
    // Small alphabet so patterns share prefixes and suffixes and failure links get exercised.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const word = (n: number) => Array.from({ length: n }, () => "abc"[Math.floor(rand() * 3)]).join("");
    for (let round = 0; round < 50; round++) {
      const patterns = Array.from({ length: 12 }, () => word(3 + Math.floor(rand() * 4)));
      const text = word(200);
      const ac = new AhoCorasick<string>(patterns.map((p) => [p, p]));
      const got = ac
        .search(text)
        .map((m) => `${m.start}:${m.pattern}`)
        .sort();
      const want = [...new Set(patterns)]
        .flatMap((p) => {
          const out: string[] = [];
          for (let i = text.indexOf(p); i !== -1; i = text.indexOf(p, i + 1)) out.push(`${i}:${p}`);
          return out;
        })
        .sort();
      expect(got).toEqual(want);
    }
  });
});

describe("variants", () => {
  it("expands a name into first, last, and 'Last, First'", () => {
    expect(variants("Quillon Vantrees")).toEqual(["quillon vantrees", "quillon", "vantrees", "vantrees, quillon"]);
  });

  it("includes middle names in the long 'Last, First Middle' form", () => {
    expect(variants("Ada Byron Lovelace")).toContain("lovelace, ada byron");
    expect(variants("Ada Byron Lovelace")).toContain("lovelace, ada");
  });

  it("adds the PersonName pseudonym form when a real name is given", () => {
    expect(variants("Anon Otter", { realName: "Quillon Vantrees" })).toContain("anon otter (quillon vantrees)");
  });

  it("keeps grades, which the redaction pass never string-matches but a leak scan must find", () => {
    expect(variants("87.31", { kind: "grade" })).toEqual(["87.31"]);
  });

  it("never returns strings under the match minimum", () => {
    expect(variants("Al Xu")).toEqual(["al xu", "xu, al"]);
  });

  it("adds the local part for emails", () => {
    expect(variants("canary.local@example.edu", { kind: "email" })).toEqual([
      "canary.local@example.edu",
      "canary.local"
    ]);
  });
});
