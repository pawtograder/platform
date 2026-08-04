/**
 * @jest-environment node
 */

/**
 * CLI list-command output helpers.
 *
 * `--json` has to emit nothing but JSON — anything else on stdout breaks
 * `| jq`. And the table printer has to pad columns, because the tab-joined
 * predecessor lined up only when every cell was shorter than a tab stop, which
 * real rosters and repository URLs are not.
 */

import {
  addJsonOption,
  emitJson,
  printTable,
  truncate,
  formatDate,
  formatDateTime,
  formatZoneLabel,
  isUsableTimeZone
} from "../../cli/utils/output";

function captureStdout(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

describe("emitJson", () => {
  it("prints the payload and reports that it handled output", () => {
    const payload = { classes: [{ id: 1, slug: "cs101" }] };
    let handled = false;
    const lines = captureStdout(() => {
      handled = emitJson({ json: true }, payload);
    });

    expect(handled).toBe(true);
    expect(JSON.parse(lines.join("\n"))).toEqual(payload);
  });

  it("prints nothing and defers to the caller when --json is absent", () => {
    let handled = true;
    const lines = captureStdout(() => {
      handled = emitJson({ json: false }, { anything: true });
    });

    expect(handled).toBe(false);
    expect(lines).toEqual([]);
  });

  it("treats a missing json flag as not set", () => {
    let handled = true;
    const lines = captureStdout(() => {
      handled = emitJson({}, { anything: true });
    });

    expect(handled).toBe(false);
    expect(lines).toEqual([]);
  });

  it("emits valid JSON for payloads holding nulls and nested objects", () => {
    const payload = { a: null, b: { c: [1, 2, null] }, d: "x" };
    const lines = captureStdout(() => emitJson({ json: true }, payload));
    expect(JSON.parse(lines.join("\n"))).toEqual(payload);
  });
});

describe("addJsonOption", () => {
  it("registers --json as a boolean defaulting to false", () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const fakeYargs = {
      option(name: string, config: Record<string, unknown>) {
        calls.push([name, config]);
        return this;
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addJsonOption(fakeYargs as any);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("json");
    expect(calls[0][1]).toMatchObject({ type: "boolean", default: false });
  });
});

describe("printTable", () => {
  it("pads every column but the last to its widest cell", () => {
    const lines = captureStdout(() =>
      printTable(
        ["ID", "Name"],
        [
          [1, "a-very-long-student-name"],
          [22, "short"]
        ]
      )
    );

    // Leading blank line, header, separator, then one line per row. The
    // separator spans the full column width, not just the heading.
    expect(lines[0]).toBe("");
    expect(lines[1]).toBe("   ID  Name");
    expect(lines[2]).toBe(`   --  ${"-".repeat("a-very-long-student-name".length)}`);
    expect(lines[3]).toBe("   1   a-very-long-student-name");
    expect(lines[4]).toBe("   22  short");
  });

  it("widens a column to fit its heading when every cell is narrower", () => {
    const lines = captureStdout(() => printTable(["Autograder"], [[7]]));

    expect(lines[1]).toBe("   Autograder");
    expect(lines[2]).toBe("   ----------");
    expect(lines[3]).toBe("   7");
  });

  it("renders null and undefined cells as a dash", () => {
    const lines = captureStdout(() => printTable(["A", "B", "C"], [[null, undefined, "x"]]));
    expect(lines[3]).toBe("   -  -  x");
  });

  it("renders booleans as Yes/No", () => {
    const lines = captureStdout(() => printTable(["Released"], [[true], [false]]));
    expect(lines[3]).toBe("   Yes");
    expect(lines[4]).toBe("   No");
  });

  it("does not leave trailing whitespace on short final cells", () => {
    const lines = captureStdout(() =>
      printTable(
        ["A", "B"],
        [
          ["x", "long-value"],
          ["y", "z"]
        ]
      )
    );

    for (const line of lines) {
      expect(line).toBe(line.replace(/\s+$/, ""));
    }
  });

  it("prints headers with no rows rather than throwing", () => {
    const lines = captureStdout(() => printTable(["ID", "Name"], []));
    expect(lines[1]).toBe("   ID  Name");
    expect(lines).toHaveLength(3);
  });

  it("tolerates rows shorter than the header", () => {
    const lines = captureStdout(() => printTable(["A", "B", "C"], [["only-a"]]));
    // Missing trailing cells become empty, and the trailing pad is trimmed —
    // the ragged row is still printed rather than dropped or throwing.
    expect(lines[3]).toBe("   only-a");
    expect(lines).toHaveLength(4);
  });
});

describe("truncate", () => {
  it("leaves short strings alone", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("collapses internal whitespace so a multiline request stays on one row", () => {
    expect(truncate("please help\n  with   this", 40)).toBe("please help with this");
  });

  it("marks truncation with an ellipsis and respects the budget", () => {
    const out = truncate("abcdefghij", 5);
    expect(out).toBe("abcd…");
    expect(out).toHaveLength(5);
  });

  it("renders empty and missing values as a dash", () => {
    expect(truncate(null, 10)).toBe("-");
    expect(truncate(undefined, 10)).toBe("-");
    expect(truncate("", 10)).toBe("-");
  });
});

describe("date formatting", () => {
  it("renders a dash for unset timestamps", () => {
    expect(formatDate(null)).toBe("-");
    expect(formatDate(undefined)).toBe("-");
    expect(formatDateTime(null)).toBe("-");
  });

  it("renders a dash rather than 'Invalid Date' for garbage", () => {
    expect(formatDate("not-a-date")).toBe("-");
    expect(formatDateTime("not-a-date")).toBe("-");
  });

  it("formats a real ISO timestamp", () => {
    expect(formatDate("2026-09-01T12:00:00Z")).not.toBe("-");
    expect(formatDateTime("2026-09-01T12:00:00Z")).not.toBe("-");
  });

  /**
   * The whole reason the `timeZone` argument exists: 00:30 UTC on the 2nd is still the
   * evening of the 1st in Boston, so a deadline rendered without the class zone lands on
   * the wrong day. Asserting the day, not merely that the result is non-empty.
   */
  it("renders a timestamp in the class time zone, not the operator's", () => {
    const iso = "2026-09-02T00:30:00Z";
    expect(formatDate(iso, "America/New_York")).toContain("9/1/2026");
    expect(formatDate(iso, "UTC")).toContain("9/2/2026");
    expect(formatDate(iso, "Asia/Tokyo")).toContain("9/2/2026");
  });

  it("honours a half-hour zone offset", () => {
    // 18:45 UTC is 00:15 the next day in Kolkata (+05:30).
    expect(formatDate("2026-09-01T18:45:00Z", "Asia/Kolkata")).toContain("9/2/2026");
  });

  /**
   * `classes.time_zone` is free text with no CHECK constraint, and `Intl` throws
   * `RangeError` on a value like `Eastern`. Unguarded that killed every list command
   * rendering a date and printed no rows at all.
   */
  it("falls back rather than throwing on a time zone Intl rejects", () => {
    expect(() => formatDate("2026-09-01T12:00:00Z", "Eastern")).not.toThrow();
    expect(formatDate("2026-09-01T12:00:00Z", "Eastern")).not.toBe("-");
    expect(() => formatDateTime("2026-09-01T12:00:00Z", "posixrules")).not.toThrow();
  });

  it("only claims a zone it could actually apply", () => {
    expect(formatZoneLabel("America/New_York")).toBe(" (times in America/New_York)");
    expect(formatZoneLabel("Eastern")).toBe("");
    expect(formatZoneLabel(null)).toBe("");
    expect(isUsableTimeZone("UTC")).toBe(true);
    expect(isUsableTimeZone("Eastern")).toBe(false);
  });
});
