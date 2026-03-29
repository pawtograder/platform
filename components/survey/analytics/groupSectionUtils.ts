import type { GroupAnalytics, SurveyResponseWithContext } from "@/types/survey-analytics";

export const GROUP_ANALYTICS_ALL_SECTIONS = "all";

export type StudentSectionSlot = {
  key: string;
  label: string;
};

/** Derive one section slot per member row from class section only (ignores lab section). */
export function sectionSlotFromResponse(r: SurveyResponseWithContext): StudentSectionSlot {
  if (r.class_section_id != null) {
    return {
      key: `class:${r.class_section_id}`,
      label: r.class_section_name?.trim() || `Class section ${r.class_section_id}`
    };
  }
  return { key: "none", label: "No class section" };
}

/** Distinct section slots for members of this group (mixed sections ⇒ multiple slots). */
export function getSectionSlotsForGroup(groupId: number, responses: SurveyResponseWithContext[]): StudentSectionSlot[] {
  const rows = responses.filter((r) => r.group_id === groupId);
  const map = new Map<string, string>();
  for (const r of rows) {
    const s = sectionSlotFromResponse(r);
    if (!map.has(s.key)) map.set(s.key, s.label);
  }
  if (map.size === 0) {
    return [{ key: "none", label: "No class section" }];
  }
  return Array.from(map.entries()).map(([key, label]) => ({ key, label }));
}

export type GroupSectionBucket = {
  key: string;
  label: string;
  groups: GroupAnalytics[];
};

/** One bucket per distinct student section; each group appears in every bucket matching any of its members. */
export function buildGroupSectionBuckets(
  groupAnalytics: GroupAnalytics[],
  responses: SurveyResponseWithContext[]
): GroupSectionBucket[] {
  const sectionMap = new Map<string, { label: string; groupIds: Set<number> }>();

  for (const g of groupAnalytics) {
    const slots = getSectionSlotsForGroup(g.groupId, responses);
    for (const slot of slots) {
      if (!sectionMap.has(slot.key)) {
        sectionMap.set(slot.key, { label: slot.label, groupIds: new Set() });
      }
      sectionMap.get(slot.key)!.groupIds.add(g.groupId);
    }
  }

  const buckets: GroupSectionBucket[] = Array.from(sectionMap.entries()).map(([key, { label, groupIds }]) => ({
    key,
    label,
    groups: groupAnalytics
      .filter((ga) => groupIds.has(ga.groupId))
      .sort((a, b) => a.groupName.localeCompare(b.groupName, undefined, { sensitivity: "base" }))
  }));

  buckets.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  return buckets;
}

export function groupAnalyticsSectionStorageKey(classId: number, surveyId: string): string {
  return `pawtograder:survey-analytics:group-student-section:${classId}:${surveyId}`;
}

export function isValidStoredSectionKey(value: string | null): value is string {
  if (value == null) return false;
  if (value === GROUP_ANALYTICS_ALL_SECTIONS) return true;
  if (value === "none") return true;
  return value.startsWith("class:");
}
