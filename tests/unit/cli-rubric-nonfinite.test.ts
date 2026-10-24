/**
 * @jest-environment node
 */

/**
 * Non-finite numbers in rubric YAML.
 *
 * YAML has literal forms for infinity and NaN; JSON has none. So `points: .inf` survives
 * parsing, `JSON.stringify` turns it into `null` on the way to the server, and a null
 * points value is indistinguishable from an absent one — which defaults to 0 and gets
 * cascaded into existing grading comments. The evidence is gone by the time the server
 * validator runs, so the hole has to be closed before the request is serialized.
 */

import * as YAML from "yaml";
import { assertFiniteNumbers } from "../../cli/utils/finiteNumbers";

function rubricWithPoints(literal: string): unknown {
  return YAML.parse(
    `name: r\nparts:\n  - name: p\n    criteria:\n      - name: c\n        checks:\n` +
      `          - name: k\n            points: ${literal}\n`
  );
}

describe("the hole this guards", () => {
  it.each([".inf", "-.inf", ".nan", "1e999", "-1e999"])("YAML %s becomes JSON null", (literal) => {
    const doc = rubricWithPoints(literal) as { parts: [{ criteria: [{ checks: [{ points: number }] }] }] };
    expect(Number.isFinite(doc.parts[0].criteria[0].checks[0].points)).toBe(false);
    expect(JSON.parse(JSON.stringify(doc)).parts[0].criteria[0].checks[0].points).toBeNull();
  });
});

describe("assertFiniteNumbers", () => {
  it.each([".inf", "-.inf", ".nan", "1e999"])("rejects a rubric whose points are %s", (literal) => {
    expect(() => assertFiniteNumbers(rubricWithPoints(literal), "")).toThrow(/Invalid YML/);
  });

  it("names the path to the offending value", () => {
    expect(() => assertFiniteNumbers(rubricWithPoints(".inf"), "")).toThrow(
      /parts\[0\]\.criteria\[0\]\.checks\[0\]\.points/
    );
  });

  it("distinguishes infinity, -infinity and not-a-number", () => {
    expect(() => assertFiniteNumbers({ a: Infinity }, "")).toThrow(/is infinity/);
    expect(() => assertFiniteNumbers({ a: -Infinity }, "")).toThrow(/is -infinity/);
    expect(() => assertFiniteNumbers({ a: NaN }, "")).toThrow(/is not-a-number/);
  });

  it("accepts an ordinary rubric, including zero and negatives", () => {
    expect(() => assertFiniteNumbers(rubricWithPoints("5"), "")).not.toThrow();
    expect(() => assertFiniteNumbers(rubricWithPoints("0"), "")).not.toThrow();
    expect(() => assertFiniteNumbers(rubricWithPoints("-2.5"), "")).not.toThrow();
  });

  it("looks inside arrays and nested objects, not just the top level", () => {
    expect(() => assertFiniteNumbers({ a: [{ b: [1, 2, Infinity] }] }, "")).toThrow(/a\[0\]\.b\[2\]/);
  });

  it("is untroubled by nulls, strings, booleans and empty containers", () => {
    expect(() => assertFiniteNumbers({ a: null, b: "x", c: true, d: [], e: {} }, "")).not.toThrow();
  });
});
