/**
 * @jest-environment node
 */

import {
  prepareInstructorBuildOutput,
  sanitizeGradingPaths,
  sliceOutputFromSentinel
} from "../../supabase/functions/cli/utils/sanitizeGradingPaths";

describe("sanitizeGradingPaths", () => {
  it("replaces GitHub Actions runner path prefix before pawtograder-grading", () => {
    const input = "/home/runner/_work/su26-hw-cyb2-aleand919/su26-hw-cyb2-aleand919/pawtograder-grading";
    expect(sanitizeGradingPaths(input)).toBe("/anonymous/pawtograder-grading");
  });

  it("preserves path segments after pawtograder-grading", () => {
    const input = "/home/runner/_work/su26-hw-cyb2-aleand919/su26-hw-cyb2-aleand919/pawtograder-grading/src/Foo.java";
    expect(sanitizeGradingPaths(input)).toBe("/anonymous/pawtograder-grading/src/Foo.java");
  });

  it("replaces multiple occurrences in one log", () => {
    const input =
      "error at /home/runner/_work/repo/repo/pawtograder-grading/a\n" +
      "also /home/runner/_work/other/other/pawtograder-grading/b";
    expect(sanitizeGradingPaths(input)).toBe(
      "error at /anonymous/pawtograder-grading/a\nalso /anonymous/pawtograder-grading/b"
    );
  });

  it("leaves text unchanged when pawtograder-grading is absent", () => {
    const input = "/home/runner/_work/repo/repo/src/Main.java";
    expect(sanitizeGradingPaths(input)).toBe(input);
  });
});

describe("sliceOutputFromSentinel", () => {
  it("returns text from the first sentinel occurrence inclusive", () => {
    const input = "noise\n> Task :compileJava\nBUILD FAILED";
    expect(sliceOutputFromSentinel(input, "> Task :compileJava")).toBe("> Task :compileJava\nBUILD FAILED");
  });

  it("returns null when sentinel is absent", () => {
    expect(sliceOutputFromSentinel("hello world", "missing")).toBeNull();
  });
});

describe("prepareInstructorBuildOutput", () => {
  it("sanitizes paths then slices from sentinel", () => {
    const raw = "prefix\n/home/runner/_work/repo/repo/pawtograder-grading\n> Task :compileJava\nFAIL";
    expect(prepareInstructorBuildOutput(raw, { sentinel: "> Task :compileJava" })).toBe("> Task :compileJava\nFAIL");
  });

  it("returns null when sentinel is missing after sanitization", () => {
    expect(prepareInstructorBuildOutput("only noise", { sentinel: "> Task :compileJava" })).toBeNull();
  });
});
