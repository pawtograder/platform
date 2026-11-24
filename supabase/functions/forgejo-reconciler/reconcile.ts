import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import {
  archivedRepoName,
  archiveRepo,
  classForgejoOrg,
  ensureAccountForUser,
  ensureOrg,
  ensureRepoFromTemplate,
  ensureStaffTeam,
  type ForgejoConfig,
  grantTeamRepos,
  grantWrite,
  readFile,
  removeCollaborator,
  revokeRepoToken,
  STALE_CLAIM_MINUTES,
  syncTeamMembers
} from "../_shared/ForgejoWrapper.ts";
import { gradeWorkflowSha } from "../_shared/forgejoGradeWorkflow.ts";

export { STALE_CLAIM_MINUTES };

/**
 * Accounts per pass, at about two Forgejo calls each. Every kick and every hourly run is a pass, so a
 * 300-person roster takes six.
 */
export const MAX_ACCOUNTS_PER_PASS = 50;

export type ReconcileResult = { provisioned: number; failures: { userId: string; error: unknown }[] };

export async function reconcileForgejoAccounts(
  supabase: SupabaseClient<Database>,
  config: ForgejoConfig,
  ensure: typeof ensureAccountForUser = ensureAccountForUser
): Promise<ReconcileResult> {
  // function-grants: service-role
  const { data: needed, error } = await supabase.rpc("forgejo_accounts_needed", {
    p_instance_url: config.url,
    p_stale_minutes: STALE_CLAIM_MINUTES,
    p_limit: MAX_ACCOUNTS_PER_PASS
  });
  if (error) throw error;

  const result: ReconcileResult = { provisioned: 0, failures: [] };
  for (const user of needed ?? []) {
    // function-grants: service-role
    const { data: claimed, error: claimError } = await supabase.rpc("claim_git_account", {
      p_user_id: user.user_id,
      p_instance_url: config.url,
      p_stale_minutes: STALE_CLAIM_MINUTES
    });
    // One user's failed claim (deleted mid-pass, say) shouldn't stop the others.
    if (claimError) {
      result.failures.push({ userId: user.user_id, error: claimError });
      continue;
    }
    if (!claimed) continue;

    // On failure the claim stays; once it is stale the next pass retries and adopts anything created.
    try {
      if (!user.email) throw new Error("user has no email, which Forgejo requires");
      const account = await ensure(config, { userId: user.user_id, email: user.email, name: user.name });
      const { error: saveError } = await supabase
        .from("git_accounts")
        .update({ remote_user_id: account.id, login: account.login })
        .eq("user_id", user.user_id)
        .eq("provider", "forgejo")
        .eq("instance_url", config.url);
      if (saveError) throw saveError;
      result.provisioned++;
    } catch (failure) {
      result.failures.push({ userId: user.user_id, error: failure });
    }
  }
  return result;
}

/** Repos per pass, at about four Forgejo calls each. */
export const MAX_REPOS_PER_PASS = 50;

export type RepoOps = {
  ensureOrg: typeof ensureOrg;
  ensureRepoFromTemplate: typeof ensureRepoFromTemplate;
  grantWrite: typeof grantWrite;
};

// Failures go to Sentry, so they name the assignment and profile, not the repo: its name ends in a login
// made from the student's email.
type RepoOwner = {
  assignment_id: number;
  class_id: number;
  profile_id: string | null;
  assignment_group_id: number | null;
};

/**
 * The row already recorded for this Forgejo repo, or null. A name that belongs to another assignment,
 * student or group is refused before any Forgejo call, so that repo is never adopted or shared: two
 * courses can share one `forgejo_org`.
 */
export async function existingRepositoryRow(
  supabase: SupabaseClient<Database>,
  repository: string,
  owner: RepoOwner
): Promise<number | null> {
  // The row first, then the pending archive. Deleting a Forgejo row queues its archive in the same
  // transaction (forgejo_repo_archive_on_delete), so a row this read misses was deleted, with its archive
  // queued, before the read, and the archive lookup below sees that entry (or it is already archived, and the
  // old repo renamed away). Reading the archives first would leave a gap: an unlink committing between the two
  // reads would find neither, and the old repo would be adopted with its old collaborators.
  const { data, error } = await supabase
    .from("repositories")
    .select("id, assignment_id, profile_id, assignment_group_id")
    .eq("git_provider", "forgejo")
    .eq("repository", repository)
    .maybeSingle();
  if (error) throw error;
  if (
    data &&
    (data.assignment_id !== owner.assignment_id ||
      data.profile_id !== owner.profile_id ||
      data.assignment_group_id !== owner.assignment_group_id)
  ) {
    throw new Error("The Forgejo repo name already belongs to another assignment, student or group");
  }
  // The old repo by this name is still on Forgejo with its old collaborators: adopting it would hand them the
  // new student's work, and archiving it later would take the repo from the new owner. archiveUnlinkedRepos
  // runs first in every pass, so this only waits a pass when that archive failed.
  const { data: pending, error: pendingError } = await supabase
    .from("forgejo_repo_archives")
    .select("id")
    .eq("repository", repository.toLowerCase())
    .is("archived_at", null)
    .limit(1);
  if (pendingError) throw pendingError;
  if (pending && pending.length > 0) {
    throw new Error("The Forgejo repo name is waiting for its previous repo to be archived");
  }
  return data?.id ?? null;
}

/** Inserts the row not ready and returns its id. */
export async function reserveRepositoryRow(
  supabase: SupabaseClient<Database>,
  owner: RepoOwner,
  repository: string
): Promise<number> {
  const { data, error } = await supabase
    .from("repositories")
    .insert({ ...owner, repository, git_provider: "forgejo", is_github_ready: false })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

/**
 * The handout has to live in the class's own org. The admin can read every course's repos, so a template_repo
 * naming another course's handout would otherwise be copied into this course's student repos.
 */
export function assertTemplateInOrg(template: string, org: string | null): void {
  const owner = template.split("/")[0];
  if (!owner || !org || owner.toLowerCase() !== org.toLowerCase()) {
    throw new Error("The template repo isn't in the class's Forgejo org");
  }
}

export type RepoReconcileResult = {
  created: number;
  failures: { assignmentId: number; profileId: string; error: unknown }[];
};

/** One student's repo, as forgejo_repos_needed describes it: owner is the org, login the student's Forgejo login. */
export type StudentRepoSpec = {
  assignment_id: number;
  class_id: number;
  profile_id: string;
  login: string;
  owner: string;
  name: string;
  template_repo: string;
};

/**
 * Creates one student's repo from the handout and makes them a writer, then records the repository row ready.
 * Shared by the reconciler's backlog and by a staff member's Test Assignment repo, which is made the same way.
 * `orgsReady` lets a pass check each org once. Returns the repository's owner/name.
 */
export async function provisionForgejoStudentRepo(
  supabase: SupabaseClient<Database>,
  config: ForgejoConfig,
  repo: StudentRepoSpec,
  ops: RepoOps = { ensureOrg, ensureRepoFromTemplate, grantWrite },
  orgsReady: Set<string> = new Set()
): Promise<string> {
  const repository = `${repo.owner}/${repo.name}`;
  const owner = {
    assignment_id: repo.assignment_id,
    class_id: repo.class_id,
    profile_id: repo.profile_id,
    assignment_group_id: null
  };
  assertTemplateInOrg(repo.template_repo, repo.owner);
  // Claim the name before any Forgejo call: a group repo in a 'both' assignment can derive the same
  // name (group "blue", login "group-blue"), and the unique index on (git_provider, repository) lets
  // only one of them hold it. The row stays not ready, so the student is still listed, until they can push.
  const id =
    (await existingRepositoryRow(supabase, repository, owner)) ??
    (await reserveRepositoryRow(supabase, owner, repository));
  if (!orgsReady.has(repo.owner)) {
    await ops.ensureOrg(config, repo.owner);
    orgsReady.add(repo.owner);
  }
  await ops.ensureRepoFromTemplate(config, repo.template_repo, repo.owner, repo.name);
  if (!(await ops.grantWrite(config, repository, repo.login))) {
    throw new Error("Forgejo doesn't report write access for the student");
  }
  const { error: readyError } = await supabase.from("repositories").update({ is_github_ready: true }).eq("id", id);
  if (readyError) throw readyError;
  return repository;
}

export async function reconcileForgejoRepos(
  supabase: SupabaseClient<Database>,
  config: ForgejoConfig,
  ops: RepoOps = { ensureOrg, ensureRepoFromTemplate, grantWrite }
): Promise<RepoReconcileResult> {
  // function-grants: service-role
  const { data: needed, error } = await supabase.rpc("forgejo_repos_needed", {
    p_instance_url: config.url,
    p_limit: MAX_REPOS_PER_PASS
  });
  if (error) throw error;

  const result: RepoReconcileResult = { created: 0, failures: [] };
  const orgsReady = new Set<string>();
  for (const repo of needed ?? []) {
    try {
      await provisionForgejoStudentRepo(supabase, config, repo, ops, orgsReady);
      result.created++;
    } catch (failure) {
      result.failures.push({ assignmentId: repo.assignment_id, profileId: repo.profile_id, error: failure });
    }
  }
  return result;
}

export type GroupRepoOps = RepoOps & { removeCollaborator: typeof removeCollaborator };

/** The group's members' Forgejo logins on this instance, as the database has them now. */
async function currentGroupLogins(
  supabase: SupabaseClient<Database>,
  assignmentGroupId: number,
  instanceUrl: string
): Promise<string[]> {
  // function-grants: service-role
  const { data, error } = await supabase.rpc("forgejo_group_member_logins", {
    p_assignment_group_id: assignmentGroupId,
    p_instance_url: instanceUrl
  });
  if (error) throw error;
  return (data ?? []).map((r) => r.login);
}

/** Accounts first, so students who just got one get their repos in the same pass. */
export type GroupRepoReconcileResult = {
  created: number;
  failures: { assignmentId: number; assignmentGroupId: number; error: unknown }[];
};

/**
 * One repo per group for released Forgejo group assignments (#1236), with every member a writer. The
 * repo is recorded as ready only once every member has a Forgejo login and Forgejo reports write
 * access for each, so a member still waiting for an account keeps the group in the next pass. Grants
 * go to the roster as read after the repo row is reserved, and a member who left during the grants is
 * removed again before the save.
 */
export async function reconcileForgejoGroupRepos(
  supabase: SupabaseClient<Database>,
  config: ForgejoConfig,
  ops: GroupRepoOps = { ensureOrg, ensureRepoFromTemplate, grantWrite, removeCollaborator }
): Promise<GroupRepoReconcileResult> {
  // function-grants: service-role
  const { data: needed, error } = await supabase.rpc("forgejo_group_repos_needed", {
    p_instance_url: config.url,
    p_limit: MAX_REPOS_PER_PASS
  });
  if (error) throw error;

  const result: GroupRepoReconcileResult = { created: 0, failures: [] };
  const orgsReady = new Set<string>();
  for (const group of needed ?? []) {
    const repository = `${group.owner}/${group.name}`;
    const owner = {
      assignment_id: group.assignment_id,
      class_id: group.class_id,
      profile_id: null,
      assignment_group_id: group.assignment_group_id
    };
    try {
      assertTemplateInOrg(group.template_repo, group.owner);
      // Refuses a name another assignment, student or group already holds.
      await existingRepositoryRow(supabase, repository, owner);
      // Claim the name before any grant. Classes can share a forgejo_org, and passes can overlap, so
      // another group may be about to take the same name; the unique index on (git_provider, repository)
      // lets only one row exist, and nothing granted is left on a repo this group doesn't own.
      // function-grants: service-role
      const { error: reserveError } = await supabase.rpc("save_forgejo_group_repo", {
        p_assignment_group_id: group.assignment_group_id,
        p_repository: repository,
        p_instance_url: config.url,
        p_granted: []
      });
      if (reserveError) throw reserveError;
      if (!orgsReady.has(group.owner)) {
        await ops.ensureOrg(config, group.owner);
        orgsReady.add(group.owner);
      }
      await ops.ensureRepoFromTemplate(config, group.template_repo, group.owner, group.name);
      // The backlog's roster may be stale. Read it again now the row exists, so a member who left before
      // the reserve (and so queued no revocation) is not granted.
      const granting = await currentGroupLogins(supabase, group.assignment_group_id, config.url);
      let allWrite = true;
      for (const login of granting) {
        if (!(await ops.grantWrite(config, repository, login))) allWrite = false;
      }
      // And once more after the grants: anyone granted who has left since is removed here, rather than left
      // to a revocation whose second removal could run before a slow grant. A leave after this read finds
      // the row and queues a revocation that runs after these grants.
      const members = new Set(
        (await currentGroupLogins(supabase, group.assignment_group_id, config.url)).map((l) => l.toLowerCase())
      );
      const granted: string[] = [];
      for (const login of granting) {
        if (members.has(login.toLowerCase())) granted.push(login);
        else await ops.removeCollaborator(config, repository, login);
      }
      if (!allWrite) throw new Error("Forgejo doesn't report write access for every group member");
      // The database decides readiness against the current roster, so a member who joined during this
      // pass leaves the repo not ready and the next pass grants them.
      // function-grants: service-role
      const { data: ready, error: saveError } = await supabase.rpc("save_forgejo_group_repo", {
        p_assignment_group_id: group.assignment_group_id,
        p_repository: repository,
        p_instance_url: config.url,
        p_granted: granted
      });
      if (saveError) throw saveError;
      if (ready) result.created++;
    } catch (failure) {
      result.failures.push({
        assignmentId: group.assignment_id,
        assignmentGroupId: group.assignment_group_id,
        error: failure
      });
    }
  }
  return result;
}

export type HashReconcileResult = { set: number; failures: { assignmentId: number; error: unknown }[] };

/**
 * Grading rejects a grade.yml whose SHA-256 differs from autograder.workflow_sha. GitHub sets it from
 * the handout (updateAutograderWorkflowHash); this does the same for Forgejo handouts (#1252). Only an
 * unset hash is filled: one already set may be what students' repos were made with. Only released
 * assignments, like the repo backlogs: a hash taken from a draft handout would never be replaced, and
 * would reject every submission if the instructor changed grade.yml before release.
 */
export async function reconcileForgejoWorkflowHashes(
  supabase: SupabaseClient<Database>,
  config: ForgejoConfig,
  read: typeof readFile = readFile
): Promise<HashReconcileResult> {
  const { data: assignments, error } = await supabase
    .from("assignments")
    .select("id, template_repo, classes!inner(slug, forgejo_org), autograder!inner(workflow_sha)")
    .eq("git_provider", "forgejo")
    // Without an autograder there is no hash to check, and those would hold their place every pass.
    .eq("has_autograder", true)
    .not("template_repo", "is", null)
    .is("autograder.workflow_sha", null)
    .lte("release_date", new Date().toISOString())
    .limit(MAX_REPOS_PER_PASS);
  if (error) throw error;

  const result: HashReconcileResult = { set: 0, failures: [] };
  for (const assignment of assignments ?? []) {
    try {
      assertTemplateInOrg(assignment.template_repo!, classForgejoOrg(assignment.classes));
      const workflow = await read(config, assignment.template_repo!, ".github/workflows/grade.yml");
      // Every submission to this assignment would be rejected, so report it rather than skip it.
      if (workflow === null) throw new Error("The handout has no .github/workflows/grade.yml");
      const workflowSha = await gradeWorkflowSha(workflow);
      const { error: saveError } = await supabase
        .from("autograder")
        .update({ workflow_sha: workflowSha })
        .eq("id", assignment.id)
        .is("workflow_sha", null);
      if (saveError) throw saveError;
      result.set++;
    } catch (failure) {
      result.failures.push({ assignmentId: assignment.id, error: failure });
    }
  }
  return result;
}

export const MAX_ARCHIVES_PER_PASS = 50;

/**
 * Writes to a pending archive entry only while `claim` (what claim_forgejo_repo_archive returned) is still its
 * claim. False when it isn't: the entry was claimed again after this claim went stale, or finished, and what
 * that pass recorded stands.
 */
export async function writeClaimedArchive(
  supabase: SupabaseClient<Database>,
  id: number,
  claim: string,
  values: Database["public"]["Tables"]["forgejo_repo_archives"]["Update"]
): Promise<boolean> {
  const { data, error } = await supabase
    .from("forgejo_repo_archives")
    .update(values)
    .eq("id", id)
    .eq("claimed_at", claim)
    .is("archived_at", null)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** `kept`: group repos not archived because the group had members again by the time the pass got to them. */
export type ArchiveResult = { archived: number; kept: number; failures: { classId: number; error: unknown }[] };

/**
 * Archives Forgejo repos that were unlinked from their student or group (#1378), the Forgejo side of
 * enqueue_github_archive_repo. Each is claimed first: a pass that listed it late must not archive a repo that
 * was re-created under the same name after another pass archived the old one.
 */
export async function archiveUnlinkedRepos(
  supabase: SupabaseClient<Database>,
  config: ForgejoConfig,
  archive: typeof archiveRepo = archiveRepo
): Promise<ArchiveResult> {
  // function-grants: service-role
  const { data: due, error } = await supabase.rpc("forgejo_repo_archives_due", {
    p_stale_minutes: STALE_CLAIM_MINUTES,
    p_limit: MAX_ARCHIVES_PER_PASS
  });
  if (error) throw error;

  const result: ArchiveResult = { archived: 0, kept: 0, failures: [] };
  for (const row of due ?? []) {
    try {
      // function-grants: service-role
      const { data: claim, error: claimError } = await supabase.rpc("claim_forgejo_repo_archive", {
        p_id: row.id,
        p_stale_minutes: STALE_CLAIM_MINUTES
      });
      if (claimError) throw claimError;
      if (!claim) continue;
      // Where the repo is going is decided and written down before Forgejo is touched. An attempt that renames
      // the repo and then loses the write below -- the pass dies, or Supabase refuses it -- leaves the old name
      // gone; without a recorded destination the retry would find nothing, mark the entry done with no name,
      // and the archive staff need would be unfindable. A destination already here is one such attempt's, so
      // it is reused rather than replaced: that is the name the repo may already be under.
      const { data: entry, error: entryError } = await supabase
        .from("forgejo_repo_archives")
        .select("archived_as")
        .eq("id", row.id)
        .single();
      if (entryError) throw entryError;
      let destination = entry.archived_as;
      if (destination === null) {
        // First attempt, so the repo hasn't been touched. A group repo is queued when its last member leaves;
        // if the group has members again, it keeps its repo. Otherwise the row (if one is left) is marked not
        // ready, so a group that gets members later is given a new repo under this name.
        // function-grants: service-role
        const { data: stillDue, error: prepareError } = await supabase.rpc("prepare_forgejo_repo_archive", {
          p_repository: row.repository
        });
        if (prepareError) throw prepareError;
        if (!stillDue) {
          // Done with no new name: nothing was renamed.
          if (
            await writeClaimedArchive(supabase, row.id, claim, {
              archived_at: new Date().toISOString(),
              archived_as: null
            })
          ) {
            result.kept++;
          }
          continue;
        }
        destination = archivedRepoName(row.repository);
        // A pass that lost its claim (it stalled past STALE_CLAIM_MINUTES and another took over) stops here.
        if (!(await writeClaimedArchive(supabase, row.id, claim, { archived_as: destination }))) continue;
      }
      // On failure the claim stays; once it's stale the next pass tries again.
      const archivedAs = await archive(config, row.repository, destination);
      const done = await writeClaimedArchive(supabase, row.id, claim, {
        archived_at: new Date().toISOString(),
        archived_as: archivedAs
      });
      if (!done) continue;
      result.archived++;
    } catch (failure) {
      result.failures.push({ classId: row.class_id, error: failure });
    }
  }
  return result;
}

export const MAX_ORG_HOOKS_PER_PASS = 20;

export type OrgHookResult = { checked: number; failures: { org: string; error: unknown }[] };

/** The API's max_rows (supabase/config.toml), so a short page means the last one. */
export const CLASS_PAGE_SIZE = 1000;

export function orgHookWindow(orgs: string[], now: number): string[] {
  const sorted = [...new Set(orgs)].sort();
  if (sorted.length <= MAX_ORG_HOOKS_PER_PASS) return sorted;
  const hour = Math.floor(now / 3_600_000);
  const start = (hour * MAX_ORG_HOOKS_PER_PASS) % sorted.length;
  return Array.from({ length: MAX_ORG_HOOKS_PER_PASS }, (_, i) => sorted[(start + i) % sorted.length]);
}

/** The repo backlogs only ensureOrg orgs with repos to create, so this upgrades every other org's hook. */
export async function reconcileForgejoOrgHooks(
  supabase: SupabaseClient<Database>,
  config: ForgejoConfig,
  ensure: typeof ensureOrg = ensureOrg,
  now: number = Date.now()
): Promise<OrgHookResult> {
  const result: OrgHookResult = { checked: 0, failures: [] };
  if (!config.pushHook) return result;
  const orgs: string[] = [];
  for (let from = 0; ; from += CLASS_PAGE_SIZE) {
    const { data: classes, error } = await supabase
      .from("classes")
      .select("slug, forgejo_org, repositories!inner(id)")
      .eq("repositories.git_provider", "forgejo")
      .limit(1, { referencedTable: "repositories" })
      .order("id")
      .range(from, from + CLASS_PAGE_SIZE - 1);
    if (error) throw error;
    for (const c of classes ?? []) {
      const org = classForgejoOrg(c);
      if (org) orgs.push(org);
    }
    if ((classes ?? []).length < CLASS_PAGE_SIZE) break;
  }
  for (const org of orgHookWindow(orgs, now)) {
    try {
      await ensure(config, org);
      result.checked++;
    } catch (failure) {
      result.failures.push({ org, error: failure });
    }
  }
  return result;
}

export const MAX_STAFF_TEAMS_PER_PASS = 50;

export type StaffTeamOps = {
  ensureStaffTeam: typeof ensureStaffTeam;
  syncTeamMembers: typeof syncTeamMembers;
  grantTeamRepos: typeof grantTeamRepos;
};

export type StaffTeamResult = {
  synced: number;
  failures: { classId: number; error: unknown }[];
};

/**
 * Each class's staff team in its Forgejo org, like the `{slug}-staff` team on GitHub: its members are the
 * class's instructors, graders and admins with a Forgejo account, and it can write to every ready student
 * and group repo and to the handouts. A class is listed every pass, since a role change or a new repo
 * leaves no mark for a backlog query; when nothing changed that costs three reads.
 */
export async function reconcileForgejoStaffTeams(
  supabase: SupabaseClient<Database>,
  config: ForgejoConfig,
  ops: StaffTeamOps = { ensureStaffTeam, syncTeamMembers, grantTeamRepos }
): Promise<StaffTeamResult> {
  // function-grants: service-role
  const { data: classes, error } = await supabase.rpc("forgejo_staff_teams", {
    p_instance_url: config.url,
    p_limit: MAX_STAFF_TEAMS_PER_PASS
  });
  if (error) throw error;

  const result: StaffTeamResult = { synced: 0, failures: [] };
  for (const cls of classes ?? []) {
    try {
      const teamId = await ops.ensureStaffTeam(config, cls.org, cls.team);
      // Recorded as soon as the team exists, before the steps that can fail: the team outlives the repos
      // that caused it (#1398 archives a deleted assignment's repos but leaves the team holding its
      // grants), and its name must outlive the class's slug and forgejo_org. From then on the backlog lists
      // the recorded org and team, so a TA dropped later loses the team that actually holds the grants.
      // function-grants: service-role
      const { error: recordError } = await supabase.rpc("record_forgejo_staff_team", {
        p_class_id: cls.class_id,
        p_instance_url: config.url,
        p_org: cls.org,
        p_team: cls.team,
        p_team_id: teamId
      });
      if (recordError) throw recordError;
      // Members first: a staff member removed from the class loses every repo at once.
      await ops.syncTeamMembers(config, teamId, cls.logins);
      await ops.grantTeamRepos(config, teamId, cls.org, cls.repositories);
      result.synced++;
    } catch (failure) {
      result.failures.push({ classId: cls.class_id, error: failure });
    }
  }
  return result;
}

export const MAX_REVOCATIONS_PER_PASS = 100;

export type RevokeResult = { revoked: number; failures: { userId: string; error: unknown }[] };

export async function revokeDroppedTokens(
  supabase: SupabaseClient<Database>,
  config: ForgejoConfig,
  revoke: typeof revokeRepoToken = revokeRepoToken
): Promise<RevokeResult> {
  // function-grants: service-role
  const { data: due, error } = await supabase.rpc("forgejo_repo_tokens_to_revoke", {
    p_instance_url: config.url,
    p_stale_minutes: STALE_CLAIM_MINUTES,
    p_limit: MAX_REVOCATIONS_PER_PASS
  });
  if (error) throw error;

  const result: RevokeResult = { revoked: 0, failures: [] };
  for (const token of due ?? []) {
    try {
      // Taken before the claim: a re-mint can only clear the claim after it, so its token is newer than this.
      const claimedAt = Date.now();
      // function-grants: service-role
      const { data: claimId, error: claimError } = await supabase.rpc("claim_forgejo_repo_token_revocation", {
        p_id: token.id,
        p_stale_minutes: STALE_CLAIM_MINUTES
      });
      if (claimError) throw claimError;
      if (claimId == null) continue;

      if (!token.login) throw new Error("Missing Forgejo login for workspace token revocation");
      await revoke(config, token.login, token.repository_id, claimedAt);

      // Match this pass's own claim: a re-mint plus a later pass's claim must keep that row.
      const { error: deleteError } = await supabase
        .from("forgejo_repo_tokens")
        .delete()
        .eq("id", token.id)
        .eq("revoke_claim_id", claimId);
      if (deleteError) throw deleteError;
      result.revoked++;
    } catch (failure) {
      result.failures.push({ userId: token.user_id, error: failure });
    }
  }
  return result;
}

export type GroupLeaveResult = {
  removed: number;
  /** Rows whose repository is gone or now answers to another name, dropped without calling Forgejo. */
  discarded: number;
  failures: { assignmentGroupId: number; profileId: string; error: unknown }[];
};

/**
 * Takes students who left a group off its Forgejo repo (#1374). The database queues one row per student and repo
 * when a membership leaves a group (20261122140100_forgejo_group_repo_revocations.sql), and cancels it if they
 * rejoin first. Each row is removed once now and once more after a 10-minute grace, in case a group pass that
 * read the roster before they left granted them afterwards.
 *
 * That grace is why the repository's identity is checked and not just its name. Archiving a repo renames it and
 * frees the name (#1398), so in those ten minutes a new group can be given a repo called the same thing; removing
 * the student from THAT one would take away access they currently have, and the repair path cannot undo it, since
 * finish_forgejo_group_repo_revocation only looks at the group the row was queued for. A row whose repository row
 * is gone, or now holds a different name, is therefore dropped without calling Forgejo: archiving removes every
 * collaborator before it renames, so the access this row exists to revoke is already gone.
 */
export async function revokeGroupLeavers(
  supabase: SupabaseClient<Database>,
  config: ForgejoConfig,
  remove: typeof removeCollaborator = removeCollaborator
): Promise<GroupLeaveResult> {
  // function-grants: service-role
  const { data: due, error } = await supabase.rpc("forgejo_group_repo_revocations_needed", {
    p_instance_url: config.url,
    p_stale_minutes: STALE_CLAIM_MINUTES,
    p_limit: MAX_REVOCATIONS_PER_PASS
  });
  if (error) throw error;

  const result: GroupLeaveResult = { removed: 0, discarded: 0, failures: [] };
  for (const row of due ?? []) {
    try {
      // function-grants: service-role
      const { data: claimId, error: claimError } = await supabase.rpc("claim_forgejo_group_repo_revocation", {
        p_id: row.id,
        p_stale_minutes: STALE_CLAIM_MINUTES
      });
      if (claimError) throw claimError;
      if (claimId == null) continue;
      // Claimed first, so the check below reads the repository while this pass holds the row.
      if (row.repository_id != null) {
        const { data: repoRow, error: repoError } = await supabase
          .from("repositories")
          .select("id, repository")
          .eq("id", row.repository_id)
          .maybeSingle();
        if (repoError) throw repoError;
        if (!repoRow || repoRow.repository.toLowerCase() !== row.repository.toLowerCase()) {
          // Deleted directly rather than through finish_forgejo_group_repo_revocation, which would test
          // membership of the group this row named and re-grant it — the wrong repo entirely. Claim-matched,
          // as revokeDroppedTokens deletes a token row, so a pass that took the row after this one read it
          // keeps its own claim.
          const { error: dropError } = await supabase
            .from("forgejo_group_repo_revocations")
            .delete()
            .eq("id", row.id)
            .eq("claim_id", claimId);
          if (dropError) throw dropError;
          result.discarded++;
          continue;
        }
      }
      // On failure the claim stays, and the row is retried once it is stale.
      await remove(config, row.repository, row.login);
      // Re-grants instead when the student is back in the group.
      // function-grants: service-role
      const { error: finishError } = await supabase.rpc("finish_forgejo_group_repo_revocation", {
        p_id: row.id,
        p_claim_id: claimId,
        p_assignment_group_id: row.assignment_group_id,
        p_profile_id: row.profile_id
      });
      if (finishError) throw finishError;
      result.removed++;
    } catch (failure) {
      result.failures.push({ assignmentGroupId: row.assignment_group_id, profileId: row.profile_id, error: failure });
    }
  }
  return result;
}

/** The steps of one pass, injectable so the orchestration can be tested without Forgejo. */
export const PASS_STEPS = {
  revoke: revokeDroppedTokens,
  archives: archiveUnlinkedRepos,
  accounts: reconcileForgejoAccounts,
  repos: reconcileForgejoRepos,
  groupRepos: reconcileForgejoGroupRepos,
  hashes: reconcileForgejoWorkflowHashes,
  orgHooks: reconcileForgejoOrgHooks,
  staffTeams: reconcileForgejoStaffTeams,
  groupLeavers: revokeGroupLeavers
};

/**
 * One pass. Token revocation runs first: it has no other trigger, and a later step may time the pass out. Then
 * unlinked repos are archived, so a name they free can be used again in the same pass; then accounts, so students
 * who just got one get their repos in the same pass; then repos, group repos, workflow hashes and org hooks; then
 * staff teams; then students who left a group lose its repo.
 */
export async function reconcileForgejo(
  supabase: SupabaseClient<Database>,
  config: ForgejoConfig,
  steps: typeof PASS_STEPS = PASS_STEPS
) {
  let revocation: RevokeResult | undefined;
  let revocationError: unknown;
  try {
    revocation = await steps.revoke(supabase, config);
  } catch (e) {
    revocationError = e;
  }
  let stepError: unknown;
  let accounts: ReconcileResult | undefined;
  let repos: RepoReconcileResult | undefined;
  let groupRepos: Awaited<ReturnType<typeof reconcileForgejoGroupRepos>> | undefined;
  let hashes: Awaited<ReturnType<typeof reconcileForgejoWorkflowHashes>> | undefined;
  let archives: ArchiveResult | undefined;
  let orgHooks: OrgHookResult | undefined;
  let staffTeams: StaffTeamResult | undefined;
  let groupLeavers: GroupLeaveResult | undefined;
  try {
    archives = await steps.archives(supabase, config);
    accounts = await steps.accounts(supabase, config);
    repos = await steps.repos(supabase, config);
    groupRepos = await steps.groupRepos(supabase, config);
    hashes = await steps.hashes(supabase, config);
    orgHooks = await steps.orgHooks(supabase, config);
  } catch (e) {
    stepError = e;
  }
  // Staff-team sync removes departed staff and the group revocation removes leavers, so each runs whatever
  // failed above, and one failing doesn't skip the other.
  try {
    staffTeams = await steps.staffTeams(supabase, config);
  } catch (e) {
    stepError ??= e;
  }
  try {
    groupLeavers = await steps.groupLeavers(supabase, config);
  } catch (e) {
    stepError ??= e;
  }
  if (revocationError !== undefined) throw revocationError;
  if (stepError !== undefined) throw stepError;
  return {
    accounts: accounts!,
    repos: repos!,
    groupRepos: groupRepos!,
    hashes: hashes!,
    archives: archives!,
    orgHooks: orgHooks!,
    staffTeams: staffTeams!,
    groupLeavers: groupLeavers!,
    revocation: revocation!
  };
}
