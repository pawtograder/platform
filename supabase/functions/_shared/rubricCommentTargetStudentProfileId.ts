import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** Same behavior as lib/rubricCommentTargetStudentProfileId.ts (Deno edge copy). */
export async function fetchRubricCheckIdsRequiringTargetStudentProfileId(
  client: SupabaseClient,
  rubricCheckIds: readonly number[]
): Promise<Set<number>> {
  const unique = [...new Set(rubricCheckIds.filter((id) => id != null))];
  if (unique.length === 0) {
    return new Set();
  }
  const { data: checks } = await client.from("rubric_checks").select("id, rubric_criteria_id").in("id", unique);
  const criteriaIds = [...new Set((checks ?? []).map((c) => c.rubric_criteria_id).filter(Boolean))] as number[];
  if (criteriaIds.length === 0) {
    return new Set();
  }
  const { data: criteria } = await client.from("rubric_criteria").select("id, rubric_part_id").in("id", criteriaIds);
  const partIds = [...new Set((criteria ?? []).map((c) => c.rubric_part_id).filter(Boolean))] as number[];
  if (partIds.length === 0) {
    return new Set();
  }
  const { data: parts } = await client.from("rubric_parts").select("id, is_individual_grading").in("id", partIds);
  const partIndividual = new Map((parts ?? []).map((p) => [p.id, Boolean(p.is_individual_grading)]));
  const critToPart = new Map((criteria ?? []).map((c) => [c.id, c.rubric_part_id]));
  const result = new Set<number>();
  for (const c of checks ?? []) {
    const partId = critToPart.get(c.rubric_criteria_id);
    if (partId != null && partIndividual.get(partId)) {
      result.add(c.id);
    }
  }
  return result;
}

export async function fetchDefaultGradeTargetStudentProfileId(
  client: SupabaseClient,
  submissionId: number
): Promise<string | null> {
  const { data: sub, error } = await client
    .from("submissions")
    .select("profile_id, assignment_group_id, assignment_id")
    .eq("id", submissionId)
    .single();
  if (error || !sub) {
    return null;
  }
  if (sub.assignment_group_id == null) {
    return sub.profile_id;
  }
  const { data: members } = await client
    .from("assignment_groups_members")
    .select("profile_id")
    .eq("assignment_group_id", sub.assignment_group_id)
    .eq("assignment_id", sub.assignment_id)
    .order("profile_id", { ascending: true });
  if (!members?.length) {
    return sub.profile_id ?? null;
  }
  const memberIds = new Set(members.map((m) => m.profile_id));
  if (sub.profile_id && memberIds.has(sub.profile_id)) {
    return sub.profile_id;
  }
  return members[0].profile_id;
}
