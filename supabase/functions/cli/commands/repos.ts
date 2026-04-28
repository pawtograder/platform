/**
 * repos.* CLI commands — metadata only (cli:read). Local git runs in cli/lib/repos.
 */

import { Buffer } from "node:buffer";
import type { MCPAuthContext } from "../../_shared/MCPAuth.ts";
import { getFileFromRepo } from "../../_shared/GitHubWrapper.ts";
import { registerCommand } from "../router.ts";
import { getAdminClient } from "../utils/supabase.ts";
import { resolveAssignment, resolveClass } from "../utils/resolvers.ts";
import { CLICommandError } from "../errors.ts";
import type {
  CLIResponse,
  ReposListParams,
  ReposListRepositoryRow,
  ReposSyncGradeWorkflowContextParams,
  ReposCrossAssignmentCopyContextParams,
  ReposCrossAssignmentCopyPair
} from "../types.ts";

const PAGE_SIZE = 1000;
const GRADE_WORKFLOW_PATH = ".github/workflows/grade.yml";

async function assertUserCanAccessClass(userId: string, classId: number): Promise<void> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from("user_roles")
    .select("id")
    .eq("user_id", userId)
    .eq("class_id", classId)
    .eq("disabled", false)
    .in("role", ["instructor", "grader"])
    .limit(1)
    .maybeSingle();

  if (error) throw new CLICommandError(`Failed to verify class access: ${error.message}`, 500);
  if (!data) {
    throw new CLICommandError("You do not have instructor/grader access to this class", 403);
  }
}

async function fetchRepositoriesForAssignment(assignmentId: number): Promise<ReposListRepositoryRow[]> {
  const supabase = getAdminClient();
  const out: ReposListRepositoryRow[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("repositories")
      .select(
        `
        id,
        repository,
        profile_id,
        assignment_group_id,
        user_roles!inner(disabled)
      `
      )
      .eq("assignment_id", assignmentId)
      .eq("user_roles.disabled", false)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      throw new CLICommandError(`Failed to fetch repositories: ${error.message}`, 500);
    }
    const rows = data ?? [];
    for (const row of rows) {
      const r = row as unknown as ReposListRepositoryRow & { user_roles?: { disabled: boolean } | null };
      out.push({
        id: r.id,
        repository: r.repository,
        profile_id: r.profile_id,
        assignment_group_id: r.assignment_group_id
      });
    }
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return out;
}

async function fetchGroupIdToName(assignmentId: number): Promise<Map<number, string>> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.from("assignment_groups").select("id, name").eq("assignment_id", assignmentId);

  if (error) {
    throw new CLICommandError(`assignment_groups: ${error.message}`, 500);
  }
  const map = new Map<number, string>();
  for (const row of data ?? []) {
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
  const BATCH = 500;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from("assignment_groups_members")
      .select("assignment_group_id, profile_id")
      .in("assignment_group_id", batch);
    if (error) {
      throw new CLICommandError(`assignment_groups_members: ${error.message}`, 500);
    }
    const sorted = [...(data ?? [])].sort((a, b) => {
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
  await assertUserCanAccessClass(ctx.userId, classData.id);

  const assignment = await resolveAssignment(supabase, classData.id, assignmentIdf);
  const repositories = await fetchRepositoriesForAssignment(assignment.id);

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
  await assertUserCanAccessClass(ctx.userId, classData.id);

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

  const repositories = await fetchRepositoriesForAssignment(assignment.id);
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
  await assertUserCanAccessClass(ctx.userId, classData.id);

  const source = await resolveAssignment(supabase, classData.id, source_assignment);
  const target = await resolveAssignment(supabase, classData.id, target_assignment);

  if (source.id === target.id) {
    throw new CLICommandError("source_assignment and target_assignment must differ", 400);
  }

  const [sourceRepos, targetRepos, sourceGroupNames, targetGroupNames] = await Promise.all([
    fetchRepositoriesForAssignment(source.id),
    fetchRepositoriesForAssignment(target.id),
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
