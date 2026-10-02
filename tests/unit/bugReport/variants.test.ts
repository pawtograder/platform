import { findBackstopSpans } from "@/lib/bugReport/regexBackstop";
import {
  matchPatterns,
  nameVariants,
  normalizeForMatch,
  personNameDisplay,
  personNameVariants
} from "@/lib/bugReport/variants";

describe("normalizeForMatch", () => {
  it("lower-cases and collapses whitespace", () => {
    expect(normalizeForMatch("  Jane\t\n  DOE ")).toBe("jane doe");
    expect(normalizeForMatch("Ｊａｎｅ")).toBe("jane");
  });
});

describe("nameVariants", () => {
  it("expands first, last, 'Last, First', and lower case", () => {
    expect(nameVariants("Jane Q. Canary").sort()).toEqual(
      ["jane q. canary", "jane", "canary", "jane canary", "canary, jane", "canary, jane q."].sort()
    );
  });

  it("reads sortable names back into 'First Last'", () => {
    expect(nameVariants("Canary, Jane").sort()).toEqual(["canary, jane", "jane", "canary", "jane canary"].sort());
  });

  it("never keeps a digit-only token on its own", () => {
    const got = nameVariants("R Student 000");
    expect(got).not.toContain("000");
    expect(got).toContain("r student 000");
  });

  it("drops tokens under 3 characters and initials", () => {
    expect(nameVariants("Al B. Canary").sort()).toEqual(
      ["al b. canary", "canary", "al canary", "canary, al", "canary, al b."].sort()
    );
    expect(nameVariants("J. D.")).toEqual([]);
    expect(nameVariants("J.D.")).toEqual([]);
    expect(nameVariants("Bo")).toEqual([]);
    expect(nameVariants("   ")).toEqual([]);
  });

  it("keeps single-token names of 3+ characters", () => {
    expect(nameVariants("Ann")).toEqual(["ann"]);
  });
});

describe("personNameVariants", () => {
  it("adds the name (real_name) form rendered by PersonName", () => {
    expect(personNameDisplay("Brave Otter", "Jane Canary")).toBe("Brave Otter (Jane Canary)");
    const v = personNameVariants("Brave Otter", "Jane Canary");
    expect(v).toContain("brave otter (jane canary)");
    expect(v).toContain("brave otter");
    expect(v).toContain("otter");
    expect(v).toContain("canary, jane");
    expect(personNameVariants("Brave Otter", null)).not.toContain("brave otter ()");
  });
});

describe("matchPatterns", () => {
  it("never string-matches grades or none", () => {
    expect(matchPatterns("87.31", "grade")).toEqual([]);
    expect(matchPatterns("anything", "none")).toEqual([]);
  });

  it("matches an email and its local part", () => {
    expect(matchPatterns("Jane.Canary@Example.test", "email")).toEqual(["jane.canary@example.test", "jane.canary"]);
  });

  it("matches handles and free text whole, and drops short values", () => {
    expect(matchPatterns("Canary-GH", "handle")).toEqual(["canary-gh"]);
    expect(matchPatterns("My  code\nfails", "free_text")).toEqual(["my code fails"]);
    expect(matchPatterns("ab", "handle")).toEqual([]);
  });

  it("expands names", () => {
    expect(matchPatterns("Jane Canary", "name")).toContain("canary, jane");
  });
});

describe("findBackstopSpans", () => {
  const spans = (text: string) => findBackstopSpans(text).map((s) => [text.slice(s.start, s.end), s.kind]);

  it("finds emails", () => {
    expect(spans("contact jane.canary+cs@mail.example.edu today")).toEqual([
      ["jane.canary+cs@mail.example.edu", "email"]
    ]);
  });

  it("does not treat package specifiers or decorators as emails", () => {
    expect(spans("npm i pkg@latest and @Component")).toEqual([]);
  });

  it("finds 9-digit NUIDs but not longer or shorter numbers", () => {
    expect(spans("NUID 001234567, ts 1727558400000, zip 02115, id=123456789.")).toEqual([
      ["001234567", "nuid"],
      ["123456789", "nuid"]
    ]);
  });

  it("covers a mailto: href as one span, including its query", () => {
    expect(spans('<a href="mailto:jane@example.test?subject=Hi">x</a>')).toEqual([
      ["mailto:jane@example.test?subject=Hi", "mailto"]
    ]);
  });

  it("returns spans sorted and non-overlapping", () => {
    const text = "b@example.test 111222333 mailto:a@example.test";
    const result = findBackstopSpans(text);
    for (let i = 1; i < result.length; i++) expect(result[i].start).toBeGreaterThanOrEqual(result[i - 1].end);
    expect(result.map((s) => s.kind)).toEqual(["email", "nuid", "mailto"]);
  });

  it("finds the emails the plain regex finds", () => {
    const EMAIL =
      /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)*\.\p{L}{2,}/gu;
    const alphabet = ["a", "b", "Z", "é", "9", ".", "-", "+", "@", "@", " ", "/", "c", "o", "m", "\u{1D49C}"];
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 3000; i++) {
      let text = "";
      for (let j = rand(30); j > 0; j--) text += alphabet[rand(alphabet.length)];
      const expected = [...text.matchAll(EMAIL)].map((m) => [m.index, m.index + m[0].length]);
      const actual = findBackstopSpans(text)
        .filter((s) => s.kind === "email")
        .map((s) => [s.start, s.end]);
      expect({ text, spans: actual }).toEqual({ text, spans: expected });
    }
  });

  it("scans a long run without an @ in linear time", () => {
    const token = "A".repeat(200_000);
    const started = performance.now();
    expect(findBackstopSpans(`${token} ${token}@ ${token}`)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
