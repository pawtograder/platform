import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ilikeLiteral } from "./RepoPush.ts";
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
 * Refuses a GitHub repo that is neither in the course's github_org nor one of the course's own grader repos.
 * Forgejo assignments keep their grader repo on GitHub (D6), usually outside any course org, and a
 * Forgejo-only course has no github_org at all, so the grader repos are matched by name. Only assignments in
 * this course count, which keeps one course's staff out of another course's graders. Any instructor can save
 * any name as grader_repo, so a grader in another course's github_org is refused too: otherwise saving one
 * would reach that course's private repos. GitHub matches names case-insensitively, so this does too.
 */
export async function assertGitHubCourseRepo(
  supabase: SupabaseClient<Database>,
  courseId: number,
  orgName: string,
  repoName: string,
  { allowPawtograderOrg }: { allowPawtograderOrg: boolean },
  // Other courses' rows aren't visible to the caller.
  adminSupabase: () => SupabaseClient<Database> = () =>
    createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!)
): Promise<void> {
  const { data: course, error } = await supabase.from("classes").select("github_org").eq("id", courseId).single();
  if (error) {
    throw new UserVisibleError(`Could not look up the GitHub org for course ${courseId}: ${error.message}`, 500);
  }
  if (typeof orgName !== "string" || typeof repoName !== "string") {
    throw new UserVisibleError("orgName and repoName must be strings", 400);
  }
  const org = orgName.toLowerCase();
  if (course.github_org?.toLowerCase() === org) return;
  if (allowPawtograderOrg && org === "pawtograder") return;

  const { data: assignments, error: graderError } = await supabase
    .from("assignments")
    .select("autograder(grader_repo)")
    .eq("class_id", courseId);
  if (graderError) {
    throw new UserVisibleError(
      `Could not look up the grader repos for course ${courseId}: ${graderError.message}`,
      500
    );
  }
  const repo = `${org}/${repoName.toLowerCase()}`;
  if (assignments.some((a) => a.autograder?.grader_repo?.trim().toLowerCase() === repo)) {
    const { data: owners, error: ownerError } = await adminSupabase()
      .from("classes")
      .select("id")
      .ilike("github_org", ilikeLiteral(org))
      .neq("id", courseId)
      .limit(1);
    if (ownerError) {
      throw new UserVisibleError(`Could not check who owns the GitHub org ${orgName}: ${ownerError.message}`, 500);
    }
    if (owners.length === 0) return;
    throw new UserVisibleError(
      `Requested ${orgName}/${repoName} on GitHub, but ${orgName} is another course's GitHub org, so it can't be this course's grader repo`,
      403
    );
  }
  throw new UserVisibleError(
    `Requested ${orgName}/${repoName} on GitHub but it is not in the course's GitHub org (${course.github_org ?? "not set"}) or one of its grader repos`,
    403
  );
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
