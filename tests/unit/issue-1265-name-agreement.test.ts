/**
 * #1265: a scanned exam is confirmed as a roster student without a second look only when the name
 * read off the paper has exactly that student's words. Named issue-* so CI's e2e-local lane runs it.
 */
import { namesEquivalent } from "@/lib/exam/nameAgreement";

describe("names that are the same name", () => {
  test.each([
    ["Clark Johnson", "Clark Johnson"],
    ["CLARK JOHNSON", "Clark Johnson"],
    ["Johnson, Clark", "Clark Johnson"],
    ["  clark   johnson ", "Clark Johnson"],
    ["José Núñez", "Jose Nunez"],
    ["Mary-Kate O'Brien", "Mary Kate O Brien"]
  ])("%p is %p", (detected, roster) => {
    expect(namesEquivalent(detected, roster)).toBe(true);
  });
});

describe("names that need the instructor to look", () => {
  test.each([
    ["ALPHA TESTER", "Clark Johnson"], // the sheet from the issue
    ["Clark Jonson", "Clark Johnson"], // one-letter OCR slip, or a different person
    ["C. Johnson", "Clark Johnson"], // initial
    ["Clark", "Clark Johnson"], // missing word
    ["Clark Johnson Jr", "Clark Johnson"], // extra word
    ["Clark Clark", "Clark Johnson"],
    ["Johnson", "Jordan Johnson"] // same surname
  ])("%p is not %p", (detected, roster) => {
    expect(namesEquivalent(detected, roster)).toBe(false);
  });

  test.each([null, undefined, "", "   ", "--"])("nothing read (%p) is never a match", (detected) => {
    expect(namesEquivalent(detected, "Clark Johnson")).toBe(false);
  });

  test("a roster student with no name is never a match", () => {
    expect(namesEquivalent("Clark Johnson", null)).toBe(false);
  });
});
