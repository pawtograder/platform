import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import {
  ensureAccountForUser,
  ensureOrg,
  ensureRepoFromTemplate,
  type ForgejoConfig,
  grantWrite
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
    if (claimError) throw claimError;
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

export type RepoReconcileResult = { created: number; failures: { repository: string; error: unknown }[] };

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
        throw new Error(`Forgejo doesn't report write access for ${repo.login}`);
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
      result.failures.push({ repository, error: failure });
    }
  }
  return result;
}

/** Accounts first, so students who just got one get their repos in the same pass. */
export async function reconcileForgejo(supabase: SupabaseClient<Database>, config: ForgejoConfig) {
  const accounts = await reconcileForgejoAccounts(supabase, config);
  const repos = await reconcileForgejoRepos(supabase, config);
  return { accounts, repos };
}
