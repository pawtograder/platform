import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import {
  ensureAccountForUser,
  ensureOrg,
  ensureRepoFromTemplate,
  type ForgejoConfig,
  grantWrite,
  readFile
} from "../_shared/ForgejoWrapper.ts";

/** A claim older than this belonged to a pass that died; the next pass adopts what it created. */
export const STALE_CLAIM_MINUTES = 10;

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
export type RepoReconcileResult = {
  created: number;
  failures: { assignmentId: number; profileId: string; error: unknown }[];
};

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
    const repository = `${repo.owner}/${repo.name}`;
    try {
      if (!orgsReady.has(repo.owner)) {
        await ops.ensureOrg(config, repo.owner);
        orgsReady.add(repo.owner);
      }
      await ops.ensureRepoFromTemplate(config, repo.template_repo, repo.owner, repo.name);
      if (!(await ops.grantWrite(config, repository, repo.login))) {
        throw new Error("Forgejo doesn't report write access for the student");
      }
      // Written only once the student can push, so a row never points at a repo they can't use.
      const { error: saveError } = await supabase.from("repositories").upsert(
        {
          assignment_id: repo.assignment_id,
          class_id: repo.class_id,
          profile_id: repo.profile_id,
          repository,
          git_provider: "forgejo",
          is_github_ready: true
        },
        { onConflict: "repository" }
      );
      if (saveError) throw saveError;
      result.created++;
    } catch (failure) {
      result.failures.push({ assignmentId: repo.assignment_id, profileId: repo.profile_id, error: failure });
    }
  }
  return result;
}

/** Accounts first, so students who just got one get their repos in the same pass. */
export type GroupRepoReconcileResult = {
  created: number;
  failures: { assignmentId: number; assignmentGroupId: number; error: unknown }[];
};

/**
 * One repo per group for released Forgejo group assignments (#1236), with every member a writer. The
 * repo is recorded as ready only once every member has a Forgejo login and Forgejo reports write
 * access for each, so a member still waiting for an account keeps the group in the next pass.
 */
export async function reconcileForgejoGroupRepos(
  supabase: SupabaseClient<Database>,
  config: ForgejoConfig,
  ops: RepoOps = { ensureOrg, ensureRepoFromTemplate, grantWrite }
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
    try {
      if (!orgsReady.has(group.owner)) {
        await ops.ensureOrg(config, group.owner);
        orgsReady.add(group.owner);
      }
      await ops.ensureRepoFromTemplate(config, group.template_repo, group.owner, group.name);
      let allWrite = true;
      for (const login of group.logins) {
        if (!(await ops.grantWrite(config, repository, login))) allWrite = false;
      }
      if (!allWrite) throw new Error("Forgejo doesn't report write access for every group member");
      const { error: saveError } = await supabase.from("repositories").upsert(
        {
          assignment_id: group.assignment_id,
          class_id: group.class_id,
          assignment_group_id: group.assignment_group_id,
          repository,
          git_provider: "forgejo",
          is_github_ready: group.all_members_have_logins
        },
        { onConflict: "repository" }
      );
      if (saveError) throw saveError;
      if (group.all_members_have_logins) result.created++;
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
 * unset hash is filled: one already set may be what students' repos were made with.
 */
export async function reconcileForgejoWorkflowHashes(
  supabase: SupabaseClient<Database>,
  config: ForgejoConfig,
  read: typeof readFile = readFile
): Promise<HashReconcileResult> {
  const { data: assignments, error } = await supabase
    .from("assignments")
    .select("id, template_repo, autograder!inner(workflow_sha)")
    .eq("git_provider", "forgejo")
    .not("template_repo", "is", null)
    .is("autograder.workflow_sha", null)
    .limit(MAX_REPOS_PER_PASS);
  if (error) throw error;

  const result: HashReconcileResult = { set: 0, failures: [] };
  for (const assignment of assignments ?? []) {
    try {
      const workflow = await read(config, assignment.template_repo!, ".github/workflows/grade.yml");
      // A handout without grading has nothing to compare.
      if (workflow === null) continue;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(workflow));
      const workflowSha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

export async function reconcileForgejo(supabase: SupabaseClient<Database>, config: ForgejoConfig) {
  const accounts = await reconcileForgejoAccounts(supabase, config);
  const repos = await reconcileForgejoRepos(supabase, config);
  const groupRepos = await reconcileForgejoGroupRepos(supabase, config);
  const hashes = await reconcileForgejoWorkflowHashes(supabase, config);
  return { accounts, repos, groupRepos, hashes };
}
