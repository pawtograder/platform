/**
 * repos.* CLI commands — metadata only (cli:read). Local git runs in cli/lib/repos.
 */

import { Buffer } from "node:buffer";
import type { MCPAuthContext } from "../../_shared/MCPAuth.ts";
import { getFileFromRepo } from "../../_shared/GitHubWrapper.ts";
import { registerCommand } from "../router.ts";
import { getAdminClient } from "../utils/supabase.ts";
import { resolveAssignment, resolveClass } from "../utils/resolvers.ts";
import { assertUserCanAccessClass } from "../utils/auth.ts";
import { pageAll } from "../utils/paging.ts";
import { CLICommandError } from "../errors.ts";
import type {
  CLIResponse,
  ReposListParams,
  ReposListRepositoryRow,
  ReposSyncGradeWorkflowContextParams,
  ReposCrossAssignmentCopyContextParams,
  ReposCrossAssignmentCopyPair
} from "../types.ts";

/** Group ids per `.in()` batch; rows per batch are drained by pageAll. */
const BATCH = 200;

const GRADE_WORKFLOW_PATH = ".github/workflows/grade.yml";

/**
 * Repositories for an assignment, excluding those owned by a disabled enrollment.
 *
 * The disabled filter is applied in memory rather than as an embedded
 * `user_roles!inner(disabled)` join. That join was on
 * `repositories.profile_id -> user_roles.private_profile_id`, and group repos are
 * inserted with a **null** `profile_id`
 * (`assignment-create-all-repos/index.ts` never sets one on the group branch), so
 * an inner join on a null key matched nothing and every group repository was
 * silently dropped. `repos list` printed "No repositories" for a group
 * assignment, and `repos sync-grade-workflow` reported success having pushed to
 * none of them — while the code just below this branches on
 * `assignment_group_id != null && !profile_id`, i.e. rows the query could never
 * return.
 */
async function fetchRepositoriesForAssignment(
  classId: number,
  assignmentId: number
): Promise<ReposListRepositoryRow[]> {
  const supabase = getAdminClient();

  const rows = await pageAll<ReposListRepositoryRow>(
    () =>
      supabase
        .from("repositories")
        .select("id, repository, profile_id, assignment_group_id")
        .eq("assignment_id", assignmentId)
        .order("id", { ascending: true }),
    "Failed to fetch repositories"
  );

  const activeProfiles = await pageAll<{ private_profile_id: string }>(
    () =>
      supabase
        .from("user_roles")
        .select("private_profile_id")
        .eq("class_id", classId)
        .eq("disabled", false)
        .order("id", { ascending: true }),
    "Failed to load active enrollments"
  );
  const active = new Set(activeProfiles.map((r) => r.private_profile_id));

  // A group repo has no profile_id, so "is its owner disabled?" has to be asked of
  // its membership instead. Keeping every null-profile row would have these
  // commands clone and push to groups whose members have all dropped — work the
  // equivalent individual filter excludes.
  const groupIds = [...new Set(rows.map((r) => r.assignment_group_id).filter((id): id is number => id != null))];
  const groupHasActiveMember = new Set<number>();
  for (let i = 0; i < groupIds.length; i += BATCH) {
    const batch = groupIds.slice(i, i + BATCH);
    const members = await pageAll<{ assignment_group_id: number; profile_id: string }>(
      () =>
        supabase
          .from("assignment_groups_members")
          .select("assignment_group_id, profile_id")
          .in("assignment_group_id", batch)
          .order("id", { ascending: true }),
      "Failed to load group members"
    );
    for (const member of members) {
      if (active.has(member.profile_id)) groupHasActiveMember.add(member.assignment_group_id);
    }
  }

  return rows.filter((r) => {
    if (r.assignment_group_id != null) return groupHasActiveMember.has(r.assignment_group_id);
    if (r.profile_id) return active.has(r.profile_id);
    // Neither an owner nor a group: nothing to attribute it to.
    return false;
  });
}

async function fetchGroupIdToName(assignmentId: number): Promise<Map<number, string>> {
  const supabase = getAdminClient();
  const rows = await pageAll<{ id: number; name: string }>(
    () =>
      supabase
        .from("assignment_groups")
        .select("id, name")
        .eq("assignment_id", assignmentId)
        .order("id", { ascending: true }),
    "assignment_groups"
  );
  const map = new Map<number, string>();
  for (const row of rows) {
    map.set(row.id, row.name);
  }
  return map;
}

function repoMatchKey(
  repo: Pick<ReposListRepositoryRow, "profile_id" | "assignment_group_id">,
  groupIdToName: Map<number, string>
): string | null {
  if (repo.assignment_group_id != null) {
    const raw = groupIdToName.get(repo.assignment_group_id);
    if (raw == null) return null;
    const name = raw.trim();
    if (name === "") return null;
    return `gn:${name}`;
  }
  if (repo.profile_id) {
    return `p:${repo.profile_id}`;
  }
  return null;
}

async function fetchGroupRepresentativeProfiles(groupIds: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (groupIds.length === 0) return map;
  const unique = [...new Set(groupIds)];
  const supabase = getAdminClient();
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    // Paged within the batch: 500 group ids can return far more than max_rows
    // member rows, and a truncated read leaves later groups without a
    // representative profile, which surfaces as a bogus
    // "could not resolve profile for due date" error per repo.
    const data = await pageAll<{ assignment_group_id: number; profile_id: string }>(
      () =>
        supabase
          .from("assignment_groups_members")
          .select("assignment_group_id, profile_id")
          .in("assignment_group_id", batch)
          .order("id", { ascending: true }),
      "assignment_groups_members"
    );
    const sorted = [...data].sort((a, b) => {
      const g = a.assignment_group_id - b.assignment_group_id;
      if (g !== 0) return g;
      return a.profile_id.localeCompare(b.profile_id);
    });
    for (const row of sorted) {
      if (!map.has(row.assignment_group_id)) {
        map.set(row.assignment_group_id, row.profile_id);
      }
    }
  }
  return map;
}

function resolveProfileForDueRpc(repo: ReposListRepositoryRow, groupProfileMap: Map<number, string>): string | null {
  if (repo.profile_id) return repo.profile_id;
  if (repo.assignment_group_id != null) {
    return groupProfileMap.get(repo.assignment_group_id) ?? null;
  }
  return null;
}

/** Strictly after due (align with autograder lateness). */
function isEligibleForCopy(finalDueIso: string): boolean {
  return Date.now() > new Date(finalDueIso).getTime();
}

async function handleReposList(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const { class: classIdf, assignment: assignmentIdf } = params as unknown as ReposListParams;
  if (!classIdf || !assignmentIdf) {
    throw new CLICommandError("class and assignment are required", 400);
  }

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, classIdf);
  await assertUserCanAccessClass(supabase, ctx.userId, classData.id);

  const assignment = await resolveAssignment(supabase, classData.id, assignmentIdf);
  const repositories = await fetchRepositoriesForAssignment(classData.id, assignment.id);

  return {
    success: true,
    data: {
      class: { id: classData.id, slug: classData.slug, name: classData.name },
      assignment: {
        id: assignment.id,
        slug: assignment.slug,
        title: assignment.title,
        template_repo: assignment.template_repo
      },
      repositories
    }
  };
}

async function handleSyncGradeWorkflowContext(
  ctx: MCPAuthContext,
  params: Record<string, unknown>
): Promise<CLIResponse> {
  const { class: classIdf, assignment: assignmentIdf } = params as unknown as ReposSyncGradeWorkflowContextParams;
  if (!classIdf || !assignmentIdf) {
    throw new CLICommandError("class and assignment are required", 400);
  }

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, classIdf);
  await assertUserCanAccessClass(supabase, ctx.userId, classData.id);

  const assignment = await resolveAssignment(supabase, classData.id, assignmentIdf);
  const templateRepo = assignment.template_repo?.trim();
  if (!templateRepo) {
    throw new CLICommandError("Assignment has no template_repo (handout)", 400);
  }

  let gradeContent: string;
  let gradeYmlBlobSha: string | null = null;
  try {
    const file = (await getFileFromRepo(templateRepo, GRADE_WORKFLOW_PATH)) as {
      content: string;
      sha?: string;
    };
    gradeContent = file.content;
    gradeYmlBlobSha = file.sha ?? null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new CLICommandError(`Could not read ${GRADE_WORKFLOW_PATH} from ${templateRepo}: ${msg}`, 400);
  }

  const repositories = await fetchRepositoriesForAssignment(classData.id, assignment.id);
  const gradeYmlBase64 = Buffer.from(gradeContent, "utf8").toString("base64");

  return {
    success: true,
    data: {
      assignment_id: assignment.id,
      class_id: classData.id,
      assignment_title: assignment.title,
      template_repo: templateRepo,
      grade_yml_base64: gradeYmlBase64,
      grade_yml_blob_sha: gradeYmlBlobSha,
      repositories
    }
  };
}

async function handleCrossAssignmentCopyContext(
  ctx: MCPAuthContext,
  params: Record<string, unknown>
): Promise<CLIResponse> {
  const {
    class: classIdf,
    source_assignment,
    target_assignment
  } = params as unknown as ReposCrossAssignmentCopyContextParams;
  if (!classIdf || !source_assignment || !target_assignment) {
    throw new CLICommandError("class, source_assignment, and target_assignment are required", 400);
  }

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, classIdf);
  await assertUserCanAccessClass(supabase, ctx.userId, classData.id);

  const source = await resolveAssignment(supabase, classData.id, source_assignment);
  const target = await resolveAssignment(supabase, classData.id, target_assignment);

  if (source.id === target.id) {
    throw new CLICommandError("source_assignment and target_assignment must differ", 400);
  }

  const [sourceRepos, targetRepos, sourceGroupNames, targetGroupNames] = await Promise.all([
    fetchRepositoriesForAssignment(classData.id, source.id),
    fetchRepositoriesForAssignment(classData.id, target.id),
    fetchGroupIdToName(source.id),
    fetchGroupIdToName(target.id)
  ]);

  const targetByKey = new Map<string, ReposListRepositoryRow>();
  for (const r of targetRepos) {
    const k = repoMatchKey(r, targetGroupNames);
    if (k) {
      const prev = targetByKey.get(k);
      if (prev) {
        console.warn(
          JSON.stringify({
            cli: "repos.cross_assignment_copy.context",
            warn: "duplicate_target_match_key",
            key: k,
            kept: prev.repository,
            overwritten_by: r.repository
          })
        );
      }
      targetByKey.set(k, r);
    }
  }

  const groupIdsNeedingProfile = sourceRepos
    .filter((r) => r.assignment_group_id != null && !r.profile_id)
    .map((r) => r.assignment_group_id!);
  const groupProfileMap = await fetchGroupRepresentativeProfiles(groupIdsNeedingProfile);

  const pairs: ReposCrossAssignmentCopyPair[] = [];
  const errors: { source_repository: string; reason: string }[] = [];

  for (const sourceRepo of sourceRepos) {
    const key = repoMatchKey(sourceRepo, sourceGroupNames);
    if (!key) {
      if (sourceRepo.assignment_group_id != null && !sourceGroupNames.has(sourceRepo.assignment_group_id)) {
        errors.push({
          source_repository: sourceRepo.repository,
          reason: `assignment_group_id ${sourceRepo.assignment_group_id} has no assignment_groups row on source`
        });
      } else if (sourceRepo.assignment_group_id != null) {
        errors.push({ source_repository: sourceRepo.repository, reason: "assignment group name is empty" });
      } else {
        errors.push({
          source_repository: sourceRepo.repository,
          reason: "missing profile_id and assignment_group_id"
        });
      }
      continue;
    }

    const targetRepo = targetByKey.get(key);
    if (!targetRepo) {
      errors.push({
        source_repository: sourceRepo.repository,
        reason: `no target repo for match key ${key}`
      });
      continue;
    }

    const profileId = resolveProfileForDueRpc(sourceRepo, groupProfileMap);
    if (!profileId) {
      errors.push({
        source_repository: sourceRepo.repository,
        reason: "could not resolve profile for due date"
      });
      continue;
    }

    const { data: dueRaw, error: dueErr } = await supabase.rpc("calculate_final_due_date", {
      assignment_id_param: source.id,
      student_profile_id_param: profileId,
      assignment_group_id_param: sourceRepo.assignment_group_id ?? undefined
    });

    if (dueErr || dueRaw == null) {
      errors.push({
        source_repository: sourceRepo.repository,
        reason: `calculate_final_due_date: ${dueErr?.message ?? "null"}`
      });
      continue;
    }

    const finalDueIso = typeof dueRaw === "string" ? dueRaw : String(dueRaw);
    pairs.push({
      source_repository: sourceRepo.repository,
      target_repository: targetRepo.repository,
      profile_id: profileId,
      assignment_group_id: sourceRepo.assignment_group_id,
      eligible_for_copy: isEligibleForCopy(finalDueIso),
      final_due_iso: finalDueIso
    });
  }

  return {
    success: true,
    data: {
      source_assignment_id: source.id,
      target_assignment_id: target.id,
      class_id: classData.id,
      source_assignment_title: source.title,
      target_assignment_title: target.title,
      pairs,
      errors
    }
  };
}

registerCommand({
  name: "repos.list",
  requiredScope: "cli:read",
  handler: handleReposList
});

registerCommand({
  name: "repos.sync_grade_workflow.context",
  requiredScope: "cli:read",
  handler: handleSyncGradeWorkflowContext
});

registerCommand({
  name: "repos.cross_assignment_copy.context",
  requiredScope: "cli:read",
  handler: handleCrossAssignmentCopyContext
});
