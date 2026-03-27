import {
  GROUP_ANALYTICS_ALL_SECTIONS,
  buildGroupSectionBuckets,
  getSectionSlotsForGroup,
  groupAnalyticsSectionStorageKey,
  isValidStoredSectionKey
} from "@/components/survey/analytics/groupSectionUtils";
import type { GroupAnalytics, SurveyResponseWithContext } from "@/types/survey-analytics";

const mockGroup = (id: number, name: string): GroupAnalytics => ({
  groupId: id,
  groupName: name,
  mentorId: null,
  mentorName: null,
  labSectionId: null,
  labSectionName: null,
  memberCount: 2,
  responseCount: 0,
  responseRate: 0,
  questionStats: {},
  alerts: [],
  overallHealthScore: 10
});

const mockRow = (
  groupId: number,
  opts: { lab?: { id: number; name: string }; cls?: { id: number; name: string } }
): SurveyResponseWithContext => ({
  response_id: `r-${groupId}-${opts.lab?.id ?? opts.cls?.id ?? "x"}`,
  profile_id: `p-${groupId}`,
  profile_name: "Student",
  is_submitted: false,
  submitted_at: null,
  response: {},
  group_id: groupId,
  group_name: "G",
  mentor_profile_id: null,
  mentor_name: null,
  lab_section_id: opts.lab?.id ?? null,
  lab_section_name: opts.lab?.name ?? null,
  class_section_id: opts.cls?.id ?? null,
  class_section_name: opts.cls?.name ?? null
});

describe("groupSectionUtils", () => {
  it("places a mixed group in two class section buckets", () => {
    const groups = [mockGroup(1, "Team A")];
    const responses: SurveyResponseWithContext[] = [
      mockRow(1, { cls: { id: 11, name: "Section A" } }),
      mockRow(1, { cls: { id: 22, name: "Section B" } })
    ];
    const buckets = buildGroupSectionBuckets(groups, responses);
    expect(buckets.map((b) => b.key).sort()).toEqual(["class:11", "class:22"]);
    for (const b of buckets) {
      expect(b.groups.map((g) => g.groupId)).toEqual([1]);
    }
  });

  it("ignores lab section; buckets only by class section", () => {
    const groups = [mockGroup(3, "Team C")];
    const responses: SurveyResponseWithContext[] = [
      mockRow(3, { lab: { id: 99, name: "Lab Only" }, cls: { id: 7, name: "Lecture 1" } })
    ];
    const buckets = buildGroupSectionBuckets(groups, responses);
    expect(buckets.map((b) => b.key)).toEqual(["class:7"]);
  });

  it("uses class section for slot", () => {
    const responses = [mockRow(2, { cls: { id: 5, name: "Lecture A" } })];
    const slots = getSectionSlotsForGroup(2, responses);
    expect(slots).toEqual([{ key: "class:5", label: "Lecture A" }]);
  });

  it("storage key is stable", () => {
    expect(groupAnalyticsSectionStorageKey(500, "survey-uuid")).toContain("500");
    expect(groupAnalyticsSectionStorageKey(500, "survey-uuid")).toContain("survey-uuid");
  });

  it("validates stored keys", () => {
    expect(isValidStoredSectionKey(GROUP_ANALYTICS_ALL_SECTIONS)).toBe(true);
    expect(isValidStoredSectionKey("lab:1")).toBe(false);
    expect(isValidStoredSectionKey("class:2")).toBe(true);
    expect(isValidStoredSectionKey("none")).toBe(true);
    expect(isValidStoredSectionKey("invalid")).toBe(false);
    expect(isValidStoredSectionKey(null)).toBe(false);
  });
});
