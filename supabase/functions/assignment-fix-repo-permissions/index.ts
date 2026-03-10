import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import { assertUserIsInstructor, wrapRequestHandler, IllegalArgumentError } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { enqueueSyncRepoPermissions } from "../_shared/GitHubWrapper.ts";

type FixRepoPermissionsRequest = {
  course_id: number;
  assignment_id: number;
};

type RepoAuditResult = {
  repository_id: number;
  repository: string;
  type: "individual" | "group";
  group_name?: string;
  student_name?: string;
  expected_usernames: string[];
  action: "enqueued_sync" | "skipped_no_usernames" | "skipped_not_ready" | "error";
  error_message?: string;
};

async function handleFixRepoPermissions(
  req: Request,
  scope: Sentry.Scope
): Promise<{ message: string; results: RepoAuditResult[]; summary: Record<string, number> }> {
  const { course_id, assignment_id } = (await req.json()) as FixRepoPermissionsRequest;
  scope?.setTag("function", "assignment-fix-repo-permissions");
  scope?.setTag("course_id", course_id.toString());
  scope?.setTag("assignment_id", assignment_id.toString());

  if (!course_id || !assignment_id) {
    throw new IllegalArgumentError("course_id and assignment_id are required");
  }

  await assertUserIsInstructor(course_id, req.headers.get("Authorization")!);

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  const { data: classData, error: classError } = await adminSupabase
    .from("classes")
    .select("slug, github_org")
    .eq("id", course_id)
    .single();
  if (classError || !classData) {
    throw new IllegalArgumentError("Course not found");
  }
  if (!classData.github_org) {
    throw new IllegalArgumentError("Course has no GitHub organization configured");
  }

  const { data: repos, error: reposError } = await adminSupabase
    .from("repositories")
    .select(
      "id, repository, profile_id, assignment_group_id, is_github_ready, " +
        "profiles(name), " +
        "assignment_groups(name, assignment_groups_members(profile_id))"
    )
    .eq("assignment_id", assignment_id)
    .eq("class_id", course_id);

  if (reposError) {
    Sentry.captureException(reposError, scope);
    throw new Error(`Failed to fetch repositories: ${reposError.message}`);
  }
  if (!repos || repos.length === 0) {
    return {
      message: "No repositories found for this assignment",
      results: [],
      summary: { total: 0 }
    };
  }

  const results: RepoAuditResult[] = [];

  for (const repo of repos) {
    const result: RepoAuditResult = {
      repository_id: repo.id,
      repository: repo.repository,
      type: repo.assignment_group_id ? "group" : "individual",
      group_name: repo.assignment_groups?.name ?? undefined,
      student_name: repo.profiles?.name ?? undefined,
      expected_usernames: [],
      action: "enqueued_sync"
    };

    try {
      if (!repo.is_github_ready) {
        result.action = "skipped_not_ready";
        results.push(result);
        continue;
      }

      let expectedUsernames: string[] = [];

      if (repo.assignment_group_id) {
        // Group repo: get all group members' GitHub usernames
        const memberProfileIds =
          repo.assignment_groups?.assignment_groups_members?.map((m: { profile_id: string }) => m.profile_id) ?? [];

        if (memberProfileIds.length > 0) {
          const { data: members, error: membersError } = await adminSupabase
            .from("user_roles")
            .select("users(github_username)")
            .in("private_profile_id", memberProfileIds)
            .eq("class_id", course_id)
            .eq("role", "student")
            .eq("github_org_confirmed", true);

          if (membersError) {
            throw new Error(`Failed to fetch group members: ${membersError.message}`);
          }

          expectedUsernames = (members ?? [])
            .map(
              (m: { users: { github_username: string | null } | null }) => m.users?.github_username?.toLowerCase() ?? ""
            )
            .filter((u: string) => u !== "");
        }
      } else if (repo.profile_id) {
        // Individual repo: get the student's GitHub username
        const { data: studentRole, error: studentError } = await adminSupabase
          .from("user_roles")
          .select("users(github_username)")
          .eq("private_profile_id", repo.profile_id)
          .eq("class_id", course_id)
          .eq("role", "student")
          .eq("github_org_confirmed", true)
          .maybeSingle();

        if (studentError) {
          throw new Error(`Failed to fetch student: ${studentError.message}`);
        }

        const username = studentRole?.users?.github_username;
        if (username) {
          expectedUsernames = [username.toLowerCase()];
        }
      }

      result.expected_usernames = expectedUsernames;

      if (expectedUsernames.length === 0) {
        result.action = "skipped_no_usernames";
        results.push(result);
        continue;
      }

      const [orgName, repoName] = repo.repository.split("/");
      await enqueueSyncRepoPermissions({
        class_id: course_id,
        course_slug: classData.slug!,
        org: orgName,
        repo: repoName,
        githubUsernames: expectedUsernames,
        debug_id: `fix-repo-permissions-${assignment_id}-${repo.id}`
      });

      result.action = "enqueued_sync";

      Sentry.addBreadcrumb({
        category: "fix-repo-permissions",
        message: `Enqueued sync for ${repo.repository}: [${expectedUsernames.join(", ")}]`,
        level: "info",
        data: {
          repository_id: repo.id,
          type: result.type,
          expected_usernames: expectedUsernames
        }
      });
    } catch (e) {
      result.action = "error";
      result.error_message = e instanceof Error ? e.message : String(e);
      Sentry.captureException(e, scope);
    }

    results.push(result);
  }

  const summary: Record<string, number> = {
    total: results.length,
    enqueued_sync: results.filter((r) => r.action === "enqueued_sync").length,
    skipped_no_usernames: results.filter((r) => r.action === "skipped_no_usernames").length,
    skipped_not_ready: results.filter((r) => r.action === "skipped_not_ready").length,
    errors: results.filter((r) => r.action === "error").length
  };

  Sentry.captureMessage(`Fix repo permissions completed for assignment ${assignment_id}`, {
    level: "info",
    tags: {
      function: "assignment-fix-repo-permissions",
      course_id: course_id.toString(),
      assignment_id: assignment_id.toString()
    },
    contexts: {
      summary: summary
    }
  });

  return {
    message: `Audited ${summary.total} repositories: ${summary.enqueued_sync} syncs enqueued, ${summary.skipped_no_usernames} skipped (no usernames), ${summary.skipped_not_ready} skipped (not ready), ${summary.errors} errors`,
    results,
    summary
  };
}

Deno.serve((req) => {
  return wrapRequestHandler(req, handleFixRepoPermissions);
});
