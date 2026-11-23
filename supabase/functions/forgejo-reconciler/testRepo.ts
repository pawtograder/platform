import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { ForgejoConfig } from "../_shared/ForgejoWrapper.ts";
import { UserVisibleError } from "../_shared/HandlerUtils.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { provisionForgejoStudentRepo, type RepoOps } from "./reconcile.ts";

export type ForgejoTestAssignment = {
  id: number;
  class_id: number;
  slug: string | null;
  template_repo: string | null;
  repo_mode: string;
  classes: { slug: string | null; forgejo_org: string | null } | null;
};

/**
 * A staff member's own repo for Test Assignment on a Forgejo assignment. It's made the way the forgejo-reconciler
 * makes a student's: the same name (class slug, assignment slug, Forgejo login) in the class's org, generated
 * from the handout, with the staff member as a writer, and recorded against their private profile, so their
 * pushes become submissions like a student's. The reconciler's backlog only lists students, so
 * autograder-create-repos-for-student calls this when staff press "Create my test repo", as GitHub's does.
 * The caller has already checked they're course staff.
 */
export async function createForgejoTestRepo(
  supabase: SupabaseClient<Database>,
  config: ForgejoConfig | null,
  assignment: ForgejoTestAssignment,
  userId: string,
  ops?: RepoOps
): Promise<{ is_ok: true; message: string }> {
  if (!config) throw new UserVisibleError("Forgejo is not set up on this deployment.", 503);
  if (assignment.repo_mode !== "template_only_staff" || !assignment.template_repo || !assignment.slug) {
    throw new UserVisibleError("This assignment has no Forgejo handout to make a test repository from yet.", 400);
  }
  const classSlug = assignment.classes?.slug;
  if (!classSlug) throw new UserVisibleError("Assignment not found", 404);

  const { data: role, error: roleError } = await supabase
    .from("user_roles")
    .select("private_profile_id")
    .eq("user_id", userId)
    .eq("class_id", assignment.class_id)
    .eq("disabled", false)
    .limit(1)
    .maybeSingle();
  if (roleError) throw roleError;
  if (!role) throw new UserVisibleError("You aren't in this course, so you can't have a test repository in it.", 403);

  const { data: account, error: accountError } = await supabase
    .from("git_accounts")
    .select("login")
    .eq("user_id", userId)
    .eq("provider", "forgejo")
    .eq("instance_url", config.url)
    .not("login", "is", null)
    .maybeSingle();
  if (accountError) throw accountError;
  if (!account?.login) {
    throw new UserVisibleError(
      "Your Forgejo account isn't ready yet. Accounts are made for everyone in a course with cloud workspaces " +
        "turned on; try again in a few minutes.",
      409
    );
  }

  // Named as forgejo_repos_needed names a student's repo, lowercased because Forgejo names are case-insensitive.
  const owner = (assignment.classes?.forgejo_org || classSlug).toLowerCase();
  const name = `${classSlug}-${assignment.slug}-${account.login}`.toLowerCase();
  let repository: string;
  try {
    repository = await provisionForgejoStudentRepo(
      supabase,
      config,
      {
        assignment_id: assignment.id,
        class_id: assignment.class_id,
        profile_id: role.private_profile_id,
        login: account.login,
        owner,
        name,
        template_repo: assignment.template_repo
      },
      ops
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : ((e as { message?: string } | null)?.message ?? String(e));
    throw new UserVisibleError(`Could not create your Forgejo test repository: ${msg}`, 502);
  }
  return { is_ok: true, message: `Created your test repository ${repository} on Forgejo.` };
}
