import { routePatternFor } from "@/lib/bugReport/routePattern";

describe("routePatternFor", () => {
  it("substitutes single params in order", () => {
    expect(
      routePatternFor("/course/12/assignments/345/submissions/9", {
        course_id: "12",
        assignment_id: "345",
        submissions_id: "9"
      })
    ).toBe("/course/[course_id]/assignments/[assignment_id]/submissions/[submissions_id]");
  });

  it("handles two params with the same value", () => {
    expect(routePatternFor("/course/5/assignments/5", { course_id: "5", assignment_id: "5" })).toBe(
      "/course/[course_id]/assignments/[assignment_id]"
    );
  });

  it("leaves static segments alone", () => {
    expect(routePatternFor("/course/12/manage/gradebook", { course_id: "12" })).toBe(
      "/course/[course_id]/manage/gradebook"
    );
    expect(routePatternFor("/admin/classes", {})).toBe("/admin/classes");
    expect(routePatternFor("/", {})).toBe("/");
  });

  it("collapses catch-all params", () => {
    expect(
      routePatternFor("/course/3/files/src/main/App.java", { course_id: "3", path: ["src", "main", "App.java"] })
    ).toBe("/course/[course_id]/files/[...path]");
  });

  it("matches encoded segments against decoded params", () => {
    expect(routePatternFor("/course/3/topic/a%20b", { course_id: "3", topic: "a b" })).toBe(
      "/course/[course_id]/topic/[topic]"
    );
  });
});
