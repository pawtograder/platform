/**
 * @jest-environment node
 */
import { describeBulkReleaseResult } from "@/lib/bulkReleaseMessage";

describe("describeBulkReleaseResult", () => {
  it("reports the RPC count, not the selection size", () => {
    // The bug: selecting 40 and releasing 12 reported "40 selected submission reviews released".
    const msg = describeBulkReleaseResult({ affected: 12, selectedCount: 40, action: "released" });
    expect(msg.status).toBe("success");
    expect(msg.description).toContain("12 submission reviews released");
    expect(msg.description).toContain("40 selected submissions");
  });

  it("treats a full release as success", () => {
    const msg = describeBulkReleaseResult({ affected: 40, selectedCount: 40, action: "released" });
    expect(msg.status).toBe("success");
    expect(msg.description).toContain("40 submission reviews released");
  });

  it("warns when nothing changed rather than reporting success", () => {
    const msg = describeBulkReleaseResult({ affected: 0, selectedCount: 40, action: "released" });
    expect(msg.status).toBe("warning");
    expect(msg.title).toBe("Nothing to release");
    expect(msg.description).toContain("already released");
  });

  it("warns for a no-op unrelease with the right wording", () => {
    const msg = describeBulkReleaseResult({ affected: 0, selectedCount: 3, action: "unreleased" });
    expect(msg.status).toBe("warning");
    expect(msg.title).toBe("Nothing to unrelease");
    expect(msg.description).toContain("not released");
  });

  it("uses singular forms for one review and one submission", () => {
    const msg = describeBulkReleaseResult({ affected: 1, selectedCount: 1, action: "released" });
    expect(msg.description).toContain("1 submission review released");
    expect(msg.description).toContain("1 selected submission");
    expect(msg.description).not.toContain("submission reviews");
  });

  it("handles affected exceeding the selection without claiming 'N of M submissions'", () => {
    // submission_reviews is unique per (submission_id, rubric_id) and the RPC has no rubric filter,
    // so one submission carrying a grading review plus a self-review contributes more than one.
    const msg = describeBulkReleaseResult({ affected: 7, selectedCount: 4, action: "released" });
    expect(msg.status).toBe("success");
    expect(msg.description).toContain("7 submission reviews released");
    expect(msg.description).toContain("4 selected submissions");
    expect(msg.description).not.toMatch(/7 of 4/);
  });
});
