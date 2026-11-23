import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Database } from "./SupabaseTypes.d.ts";
import { UserVisibleError } from "./HandlerUtils.ts";
import { ForgejoNotConfiguredError, type RepoFiles, repoFilesOn } from "./GitProvider.ts";

/** repoFilesOn, with a deployment that has no Forgejo settings reported to the caller as 503. */
export function repoFilesFor(gitProvider: "github" | "forgejo"): RepoFiles {
  try {
    return repoFilesOn(gitProvider);
  } catch (error) {
    if (error instanceof ForgejoNotConfiguredError) throw new UserVisibleError(error.message, 503);
    throw error;
  }
}

/**
 * The host a repository-get-file / -list-files / -write-file request names. Omitted means GitHub, which is
 * what every caller meant before Forgejo existed.
 */
export function parseGitProvider(value: unknown): "github" | "forgejo" {
  if (value === undefined || value === null || value === "github") return "github";
  if (value === "forgejo") return "forgejo";
  throw new UserVisibleError("gitProvider must be github or forgejo", 400);
}

/** The class's Forgejo org, lowercased: forgejo_org, else the slug, as forgejo_repos_needed names it. */
export function forgejoOrgForClass(cls: { slug: string | null; forgejo_org: string | null }): string | null {
  const org = cls.forgejo_org?.trim() || cls.slug;
  return org ? org.toLowerCase() : null;
}

/**
 * Refuses a Forgejo org that isn't the course's. Pawtograder's admin can read every org on the instance, so
 * this check is what keeps one course's staff out of another course's repos, as the github_org check does on
 * GitHub. Forgejo matches names case-insensitively, so this does too. Like the GitHub check, it scopes to
 * the org, not the repo: courses that share a forgejo_org can reach each other's repos.
 */
export async function assertForgejoCourseOrg(
  supabase: SupabaseClient<Database>,
  courseId: number,
  orgName: string
): Promise<void> {
  const { data, error } = await supabase.from("classes").select("slug, forgejo_org").eq("id", courseId).single();
  if (error) {
    throw new UserVisibleError(`Could not look up the Forgejo org for course ${courseId}: ${error.message}`, 500);
  }
  const org = forgejoOrgForClass(data);
  if (!org || typeof orgName !== "string" || orgName.toLowerCase() !== org) {
    throw new UserVisibleError(
      `Requested ${orgName} on Forgejo but the course's Forgejo org is ${org ?? "not set"}`,
      403
    );
  }
}
