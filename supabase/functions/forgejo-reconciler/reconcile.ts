import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { ensureAccountForUser, type ForgejoConfig, revokeRepoToken } from "../_shared/ForgejoWrapper.ts";

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
      // function-grants: service-role
      const { data: claimedAt, error: claimError } = await supabase.rpc("claim_forgejo_repo_token_revocation", {
        p_id: token.id,
        p_stale_minutes: STALE_CLAIM_MINUTES
      });
      if (claimError) throw claimError;
      if (!claimedAt) continue;

      if (!token.login) throw new Error("Missing Forgejo login for workspace token revocation");
      await revoke(config, token.login, token.repository_id);

      // Only the row this pass claimed. A re-mint clears the claim (record_forgejo_repo_token) and a
      // later pass stamps its own, so matching the stamp leaves that pass's row, and its token, tracked.
      const { error: deleteError } = await supabase
        .from("forgejo_repo_tokens")
        .delete()
        .eq("id", token.id)
        .eq("revoke_claimed_at", claimedAt);
      if (deleteError) throw deleteError;
      result.revoked++;
    } catch (failure) {
      result.failures.push({ userId: token.user_id, error: failure });
    }
  }
  return result;
}
