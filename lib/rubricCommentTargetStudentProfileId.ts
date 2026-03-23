import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Rubric check IDs whose rubric part uses is_individual_grading (requires target_student_profile_id on rubric-linked comments).
 */
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

/**
 * Like {@link fetchRubricCheckIdsRequiringTargetStudentProfileId}, but one combined lookup for all check IDs,
 * then partitions results per rubric (avoids N serial round-trips per rubric).
 */
export async function fetchRubricCheckIdsRequiringTargetStudentProfileIdsBatch(
  client: SupabaseClient,
  rubricIdToCheckIds: ReadonlyMap<number, readonly number[]>
): Promise<Map<number, Set<number>>> {
  const out = new Map<number, Set<number>>();
  const allCheckIds: number[] = [];
  for (const ids of rubricIdToCheckIds.values()) {
    allCheckIds.push(...ids);
  }
  const requiringTarget = await fetchRubricCheckIdsRequiringTargetStudentProfileId(client, allCheckIds);
  for (const [rubricId, checkIds] of rubricIdToCheckIds.entries()) {
    const set = new Set<number>();
    for (const id of checkIds) {
      if (requiringTarget.has(id)) {
        set.add(id);
      }
    }
    out.set(rubricId, set);
  }
  return out;
}

/**
 * Default profile to attribute individual rubric comments to: submitter if they are in the group, else lexicographically first group member; sole submitter when there is no group.
 */
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

/**
 * Same behavior as {@link fetchDefaultGradeTargetStudentProfileId} per submission, using batched queries
 * (one submissions load + one assignment_groups_members load when any submission has a group).
 */
export async function fetchDefaultGradeTargetStudentProfileIdsBatch(
  client: SupabaseClient,
  submissionIds: readonly number[]
): Promise<Map<number, string | null>> {
  const result = new Map<number, string | null>();
  const unique = [...new Set(submissionIds.filter((id) => id != null))];
  for (const id of unique) {
    result.set(id, null);
  }
  if (unique.length === 0) {
    return result;
  }

  const { data: subs, error } = await client
    .from("submissions")
    .select("id, profile_id, assignment_group_id, assignment_id")
    .in("id", unique);

  if (error || !subs?.length) {
    return result;
  }

  const subsById = new Map(subs.map((s) => [s.id, s]));
  const groupIds = [...new Set(subs.map((s) => s.assignment_group_id).filter((id): id is number => id != null))];

  type MemberRow = { assignment_group_id: number; assignment_id: number; profile_id: string };
  const membersByCompositeKey = new Map<string, MemberRow[]>();

  if (groupIds.length > 0) {
    const { data: members } = await client
      .from("assignment_groups_members")
      .select("assignment_group_id, assignment_id, profile_id")
      .in("assignment_group_id", groupIds);

    for (const m of members ?? []) {
      const key = `${m.assignment_group_id}:${m.assignment_id}`;
      let bucket = membersByCompositeKey.get(key);
      if (!bucket) {
        bucket = [];
        membersByCompositeKey.set(key, bucket);
      }
      bucket.push(m);
    }
    for (const bucket of membersByCompositeKey.values()) {
      bucket.sort((a, b) => a.profile_id.localeCompare(b.profile_id));
    }
  }

  for (const id of unique) {
    const sub = subsById.get(id);
    if (!sub) {
      continue;
    }
    if (sub.assignment_group_id == null) {
      result.set(id, sub.profile_id);
      continue;
    }
    const key = `${sub.assignment_group_id}:${sub.assignment_id}`;
    const members = membersByCompositeKey.get(key) ?? [];
    if (members.length === 0) {
      result.set(id, sub.profile_id ?? null);
      continue;
    }
    const memberIds = new Set(members.map((m) => m.profile_id));
    if (sub.profile_id && memberIds.has(sub.profile_id)) {
      result.set(id, sub.profile_id);
    } else {
      result.set(id, members[0].profile_id);
    }
  }

  return result;
}

export async function resolveTargetStudentProfileIdForRubricComment(
  client: SupabaseClient,
  submissionId: number,
  rubricCheckId: number | null | undefined
): Promise<string | null> {
  if (rubricCheckId == null) {
    return null;
  }
  const required = await fetchRubricCheckIdsRequiringTargetStudentProfileId(client, [rubricCheckId]);
  if (!required.has(rubricCheckId)) {
    return null;
  }
  return fetchDefaultGradeTargetStudentProfileId(client, submissionId);
}
