/**
 * @jest-environment node
 */
import { graderResultIndicatesFailure } from "@/lib/graderResultStatus";

describe("graderResultIndicatesFailure", () => {
  it("is false when there is no errors payload", () => {
    expect(graderResultIndicatesFailure(null)).toBe(false);
    expect(graderResultIndicatesFailure(undefined)).toBe(false);
  });

  // The default has to stay "failure": every payload written before the marker existed lacks it,
  // and those are all real failures. Only an explicit marker opts out.
  it("is true for a legacy payload with no marker", () => {
    expect(graderResultIndicatesFailure({ user_visible_message: "build failed" })).toBe(true);
  });

  it("is false for the preserved-run warning", () => {
    expect(graderResultIndicatesFailure({ is_warning: true, user_visible_message: "previous results kept" })).toBe(
      false
    );
  });

  // Guards against a truthy-but-not-true value quietly suppressing a real failure.
  it("only a literal true suppresses the failure verdict", () => {
    expect(graderResultIndicatesFailure({ is_warning: "yes" })).toBe(true);
    expect(graderResultIndicatesFailure({ is_warning: 1 })).toBe(true);
    expect(graderResultIndicatesFailure({ is_warning: false })).toBe(true);
  });

  it("an array payload is a failure, not a marker lookup", () => {
    expect(graderResultIndicatesFailure([{ is_warning: true }])).toBe(true);
  });
});
