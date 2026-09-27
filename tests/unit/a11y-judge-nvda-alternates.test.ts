/**
 * Unit tests for the real-NVDA driver's line-segment alternates
 * (tools/a11y-judge/nvda/nvdaHarness.ts nvdaLineSegmentAlternates) and for what
 * they do to milestone matching.
 *
 * NVDA speaks a browse-mode line as one comma-joined utterance — the containers
 * it entered or left, the role/state words, and the accessible name — while the
 * plans were recorded on the virtual screen reader, which walks one control at a
 * time. Milestone matching is head-anchored, so a milestone NVDA speaks anywhere
 * but first was unmatchable. Every `item=` string below is quoted verbatim from
 * enforce run 30702006927, whose two failures were exactly that.
 *
 * No NVDA and no Windows needed: nvdaLineSegmentAlternates is pure, and
 * @guidepup/guidepup is imported type-only by the module under test.
 */
import { NVDA_MAX_LINE_ALTERNATES, nvdaLineSegmentAlternates } from "@/tools/a11y-judge/nvda/nvdaHarness";
import { milestoneMatches } from "@/tools/a11y-judge/agent/replay";
import type { AtObservation } from "@/tools/a11y-judge/agent/atHarness";

const observe = (currentItem: string, withAlternates: boolean): AtObservation => ({
  spokenSinceLastAction: [],
  currentItem,
  domFocus: null,
  ...(withAlternates ? { currentItemAlternates: nvdaLineSegmentAlternates(currentItem) } : {})
});

describe("nvdaLineSegmentAlternates", () => {
  it("offers the name behind NVDA's context and role prefixes", () => {
    // survey-taking__survey-complete, step 23, cmd#1442 / cmd#1359.
    expect(nvdaLineSegmentAlternates("out of grouping, clickable, heading, level 2, Any other feedback?")).toEqual([
      "Any other feedback?"
    ]);
    expect(nvdaLineSegmentAlternates("out of edit, clickable, button, Complete")).toEqual(["Complete"]);
  });

  it("offers each control of a line that coalesces several of them", () => {
    // discussion__discussion-reply, step 11, cmd#164. The Reply button is a
    // sibling on the same rendered line as Like and Edit, so NVDA never gives it
    // an arrow press of its own.
    expect(nvdaLineSegmentAlternates("Like (0 likes), button, Edit, button, Reply")).toEqual(["Reply"]);
  });

  it("keeps container-entry announcements from hiding the object", () => {
    // office-hours__help-request, milestone "submit request", cmd#460.
    expect(
      nvdaLineSegmentAlternates("Office Hours, region, New Help Request Form, form, button, Submit Request")
    ).toEqual(["New Help Request Form, form, button, Submit Request", "Submit Request"]);
  });

  it("drops suffixes that start on role, state or number words", () => {
    // "button, Edit, button, Reply" and "level 2, ..." name nothing the
    // head-anchored matcher cannot already reach, and a bare role word must
    // never be able to satisfy a milestone.
    for (const alternate of nvdaLineSegmentAlternates("out of grouping, clickable, heading, level 2, Feedback")) {
      expect(alternate.startsWith("clickable")).toBe(false);
      expect(alternate.startsWith("heading")).toBe(false);
      expect(alternate.startsWith("level")).toBe(false);
    }
  });

  it("returns nothing for an item that is a single segment", () => {
    expect(nvdaLineSegmentAlternates("Submit Request")).toEqual([]);
    expect(nvdaLineSegmentAlternates("")).toEqual([]);
  });

  it("keeps the shortest suffixes when a line runs long", () => {
    const long = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India"].join(", ");
    const alternates = nvdaLineSegmentAlternates(long);
    expect(alternates.length).toBe(NVDA_MAX_LINE_ALTERNATES);
    expect(alternates.at(-1)).toBe("India");
  });
});

describe("milestone matching with NVDA line-segment alternates", () => {
  // The two enforce-30702006927 failures: 125 resync presses each, walking over
  // these items twice, with the milestone gate never once consulted because
  // nothing ever claimed a match.
  const unmatchable: Array<[string, string]> = [
    ["any other feedback?", "out of grouping, clickable, heading, level 2, Any other feedback?"],
    ["any other feedback?", "out of edit, clickable, heading, level 2, Any other feedback?"],
    ["reply", "Like (0 likes), button, Edit, button, Reply"],
    ["reply", "Discussion, region, button, Like (0 likes), button, Edit, button, Reply"],
    ["complete", "out of edit, clickable, button, Complete"]
  ];

  it.each(unmatchable)("was unmatchable and now matches: %s", (milestone, item) => {
    expect(milestoneMatches(milestone, observe(item, false), {})).toBe(false);
    expect(milestoneMatches(milestone, observe(item, true), {})).toBe(true);
  });

  it("still refuses a milestone the item does not name", () => {
    const item = "Like (0 likes), button, Edit, button, Reply";
    expect(milestoneMatches("post", observe(item, true), {})).toBe(false);
    expect(milestoneMatches("submit request", observe(item, true), {})).toBe(false);
  });

  it("does not let a bare role word satisfy a milestone", () => {
    const item = "out of grouping, clickable, heading, level 2, Any other feedback?";
    expect(milestoneMatches("heading", observe(item, true), {})).toBe(false);
    expect(milestoneMatches("clickable", observe(item, true), {})).toBe(false);
  });

  it("leaves an item that already leads with its name alone", () => {
    // The six read tasks and four of office-hours' six milestones match here,
    // and must keep matching by exactly the same route.
    for (const [milestone, item] of [
      ["submit request", "Submit Request, button"],
      ["what is your name?", "What is your name?, heading, level 2"],
      ["new request", "New Request"]
    ] as const) {
      expect(milestoneMatches(milestone, observe(item, false), {})).toBe(true);
      expect(milestoneMatches(milestone, observe(item, true), {})).toBe(true);
    }
  });
});
