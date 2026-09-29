/**
 * The taint trace's phase-2 upload scan (tests/e2e/bugReport/uploadTrace.ts): the trace route
 * policy, and finding and placing canaries in a would-be upload.
 */
import { ROUTE_POLICY } from "@/lib/bugReport/routePolicy";
import type { CanaryRegistry } from "@/tests/e2e/bugReport/canaryRegistry";
import { findUploadHits, traceLevelFor, traceRoutePolicy, uploadLeaves } from "@/tests/e2e/bugReport/uploadTrace";

const registry: CanaryRegistry = new Map([
  ["Zorvik Quellmar", { kind: "name", column: "profiles.name", rowId: 1 }],
  ["94.56", { kind: "grade", column: "submission_reviews.total_score", rowId: 2 }]
]);

function upload(recording: unknown[][], feedback: unknown = { message: "x", url: "http://h/course/1" }) {
  return JSON.stringify({ replay_event: { urls: ["http://h/course/1/gradebook"] }, recording, feedback });
}

const meta = { type: 4, timestamp: 1, data: { href: "http://h/course/1/gradebook", width: 1, height: 1 } };

describe("trace route policy", () => {
  test("listed routes keep their level; staff and class-wide sections are structure", () => {
    for (const e of ROUTE_POLICY) expect(traceLevelFor(e.pattern)).toBe(e.level);
    expect(traceLevelFor("/course/[course_id]/manage/course/enrollments")).toBe("structure");
    expect(traceLevelFor("/course/[course_id]/grade/assignments/[assignment_id]/submissions/[submissions_id]")).toBe(
      "structure"
    );
    expect(traceLevelFor("/course/[course_id]/polls")).toBe("structure");
    expect(traceLevelFor("/course/[course_id]/assignments")).toBe("full");
    expect(traceLevelFor("/course/[course_id]")).toBe("full");
  });

  test("lists every course page except test harness pages", () => {
    const patterns = traceRoutePolicy().map((e) => e.pattern);
    expect(patterns).toContain("/course/[course_id]/manage/gradebook");
    expect(patterns).toContain("/course/[course_id]/office-hours/[queue_id]");
    expect(patterns.every((p) => p.startsWith("/course/[course_id]"))).toBe(true);
    expect(patterns.some((p) => p.includes("e2e-harness"))).toBe(false);
  });
});

describe("findUploadHits", () => {
  test("nothing to find", () => {
    expect(findUploadHits(upload([[meta]]), registry)).toEqual([]);
  });

  test("places a hit in a snapshot attribute, with the checkout's route", () => {
    const snapshot = {
      type: 2,
      timestamp: 2,
      data: {
        node: {
          id: 1,
          type: 0,
          childNodes: [{ id: 5, type: 2, tagName: "a", attributes: { title: "Zorvik Quellmar" }, childNodes: [] }]
        }
      }
    };
    const hits = findUploadHits(upload([[meta, snapshot]]), registry);
    expect(hits).toHaveLength(1);
    expect(hits[0].hit.entry.column).toBe("profiles.name");
    expect(hits[0].leaf.where).toBe("segment 0 event 1 FullSnapshot node #5 <a> [title]");
    expect(hits[0].leaf.recordedRoute).toBe("/course/[course_id]/gradebook");
  });

  test("places hits in mutations, breadcrumbs, and the feedback", () => {
    const mutation = { type: 3, timestamp: 3, data: { source: 0, texts: [{ id: 9, value: "by zorvik" }], adds: [] } };
    const crumb = {
      type: 5,
      timestamp: 4,
      data: { tag: "breadcrumb", payload: { category: "console", message: "quellmar" } }
    };
    const hits = findUploadHits(upload([[meta, mutation, crumb]], { url: "http://h/?q=Zorvik%20Quellmar" }), registry);
    expect(hits.map((h) => h.leaf.where).sort()).toEqual([
      "feedback.url",
      "segment 0 event 1 Mutation text #9",
      "segment 0 event 2 Custom breadcrumb console.message"
    ]);
  });

  test("a grade in stylesheet text or inside a longer number is not a hit; in page text it is", () => {
    const css = {
      type: 2,
      timestamp: 2,
      data: {
        node: {
          id: 1,
          type: 0,
          childNodes: [
            { id: 2, type: 2, tagName: "link", attributes: { _cssText: "ascent-override: 94.56%;" }, childNodes: [] },
            { id: 3, type: 2, tagName: "path", attributes: { d: "M194.567 2" }, childNodes: [] },
            { id: 4, type: 3, textContent: "Score 94.56" }
          ]
        }
      }
    };
    const hits = findUploadHits(upload([[meta, css]]), registry);
    expect(hits.map((h) => h.leaf.where)).toEqual(["segment 0 event 1 FullSnapshot text node #4 in <document>"]);
  });

  test("uploadLeaves covers the replay event and the feedback", () => {
    const leaves = uploadLeaves(JSON.parse(upload([[meta]])));
    expect(leaves.map((l) => l.where)).toEqual(
      expect.arrayContaining(["replay_event.urls[0]", "feedback.url", "segment 0 event 0 Meta.href"])
    );
  });
});
