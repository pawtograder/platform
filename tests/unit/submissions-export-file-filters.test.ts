/**
 * @jest-environment node
 */

import { matchesSubmissionFilePath } from "../../supabase/functions/cli/utils/filePathMatchers";

describe("submissions export file path filters", () => {
  it("includes all files when no filters are set", () => {
    expect(matchesSubmissionFilePath("src/Main.java", undefined, undefined)).toBe(true);
    expect(matchesSubmissionFilePath("README.md", [], [])).toBe(true);
  });

  it("requires a match when include patterns are set", () => {
    expect(matchesSubmissionFilePath("src/Main.java", ["*.java"], undefined)).toBe(true);
    expect(matchesSubmissionFilePath("src/Main.java", ["**/*.py"], undefined)).toBe(false);
    expect(matchesSubmissionFilePath("src/Main.java", ["src/**"], undefined)).toBe(true);
  });

  it("skips files matching exclude patterns", () => {
    expect(matchesSubmissionFilePath("build/output.txt", undefined, ["build/**"])).toBe(false);
    expect(matchesSubmissionFilePath("src/Main.java", undefined, ["*.java"])).toBe(false);
    expect(matchesSubmissionFilePath("src/Main.java", undefined, ["build/**"])).toBe(true);
  });

  it("applies include before exclude", () => {
    expect(matchesSubmissionFilePath("src/Main.java", ["src/**"], ["**/Main.java"])).toBe(false);
    expect(matchesSubmissionFilePath("src/Helper.java", ["src/**"], ["**/Main.java"])).toBe(true);
  });
});
