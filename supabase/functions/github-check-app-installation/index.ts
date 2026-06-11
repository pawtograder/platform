/**
 * Checks whether the Pawtograder GitHub App is installed in (and can see) a
 * given repo. Used by the assignment config form before saving a PR-mode
 * assignment whose upstream/handout repo may live OUTSIDE the class org: ptg
 * can only ingest PRs/checks/deployments from that repo, and receive its
 * webhooks at all, if the app is installed in its org.
 *
 * Request:  { repo: "owner/name", class_id: number }
 * Response: { installed, repo_accessible, org, install_url }
 *
 * Authorization: caller must be an instructor in `class_id`.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getOctoKit, getRepo, getAppSlug, getOrgId } from "../_shared/GitHubWrapper.ts";
import { UserVisibleError, SecurityError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";

type RequestBody = {
  repo: string;
  class_id: number;
};

export type CheckAppInstallationResponse = {
  installed: boolean;
  repo_accessible: boolean;
  org: string;
  install_url: string;
};

async function handleRequest(req: Request, scope: Sentry.Scope): Promise<CheckAppInstallationResponse> {
  const { repo, class_id }: RequestBody = await req.json();
  scope?.setTag("function", "github-check-app-installation");
  scope?.setTag("repo", repo);

  if (!repo || !repo.includes("/")) {
    throw new UserVisibleError('Repository must be in "owner/name" form', 400);
  }
  if (!class_id) {
    throw new UserVisibleError("class_id is required", 400);
  }

  // Authorize: caller must be an instructor in this class.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new SecurityError("Missing Authorization header");
  }
  const supabase = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } }
  });
  const token = authHeader.replace("Bearer ", "");
  const {
    data: { user }
  } = await supabase.auth.getUser(token);
  if (!user) {
    throw new SecurityError("User not found");
  }
  const { data: role } = await supabase
    .from("user_roles")
    .select("id")
    .eq("role", "instructor")
    .eq("class_id", class_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!role) {
    throw new SecurityError("Unauthorized");
  }

  const [org, name] = repo.split("/");
  const slug = await getAppSlug(scope);
  // Where to install if missing. With a known slug we deep-link to the org's install
  // flow; GitHub's `target_id` must be the org's NUMERIC account id (not its login),
  // so resolve it and omit target_id (still a valid generic deep-link) if we can't.
  let install_url = "https://github.com/settings/installations";
  if (slug) {
    const orgId = await getOrgId(org, scope);
    install_url = orgId
      ? `https://github.com/apps/${slug}/installations/new/permissions?target_id=${orgId}`
      : `https://github.com/apps/${slug}/installations/new`;
  }

  // The app is installed in `org` iff we can resolve an installation octokit.
  const octokit = await getOctoKit(org, scope);
  if (!octokit) {
    return { installed: false, repo_accessible: false, org, install_url };
  }

  // Installed — confirm the specific repo is visible to that installation.
  let repo_accessible = false;
  try {
    await getRepo(org, name, scope);
    repo_accessible = true;
  } catch (e) {
    // 404 → app is installed in the org but not granted access to this repo.
    const status = (e as { status?: number })?.status;
    if (status !== 404) {
      Sentry.captureException(e, scope);
    }
  }

  return { installed: true, repo_accessible, org, install_url };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
