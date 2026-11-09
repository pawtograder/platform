// The Supabase side of workspace-open and workspace-status (#1222): the caller, the configuration,
// and the queries behind WorkspaceDb.
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { WorkspaceOpenRequest } from "./FunctionTypes.d.ts";
import { coderConfig } from "./CoderWrapper.ts";
import {
  type Budget,
  budgetFetch,
  type Caller,
  type Deps,
  type RepositoryRow,
  type WorkspaceDb,
  type WorkspaceRow
} from "./CoderWorkspace.ts";
import { assertAuthLookupSucceeded, readJsonObjectBody, SecurityError, UserVisibleError } from "./HandlerUtils.ts";
import { REQUEST_SCOPED_AUTH_OPTIONS } from "./requestScopedAuthOptions.ts";
import type { Database } from "./SupabaseTypes.d.ts";

const REPOSITORY_COLUMNS = "id, assignment_id, class_id, profile_id, assignment_group_id, repository, git_provider";
const WORKSPACE_COLUMNS =
  "id, coder_user_id, coder_workspace_name, coder_workspace_id, superseded_at, restart_started_at, restart_phase, restart_token";

function check<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
}

/**
 * A Supabase client whose calls the budget cuts off. PostgREST retries are off: postgrest-js
 * 2.117.1 retries a GET that fails with anything but an AbortError, the signal's TimeoutError
 * included, or that is answered 503, after back-off sleeps (1, 2 and 4 s) the signal doesn't end.
 */
export function budgetClient(
  url: string,
  key: string,
  budget: Budget,
  headers: Record<string, string> = {},
  base: typeof fetch = fetch
): SupabaseClient<Database> {
  return createClient<Database>(url, key, {
    auth: REQUEST_SCOPED_AUTH_OPTIONS,
    global: { headers, fetch: budgetFetch(budget, base) },
    db: { retry: false }
  });
}

export function supabaseWorkspaceDb(admin: SupabaseClient<Database>): WorkspaceDb {
  return {
    async getAssignment(assignmentId) {
      return check(
        await admin.from("assignments").select("id, class_id, git_provider").eq("id", assignmentId).maybeSingle(),
        "Assignment lookup"
      );
    },
    async getEnrollment(userId, classId) {
      return check(
        await admin
          .from("user_roles")
          .select("private_profile_id, disabled")
          .eq("user_id", userId)
          .eq("class_id", classId)
          .maybeSingle(),
        "Enrollment lookup"
      );
    },
    async getGroupId(assignmentId, profileId) {
      const row = check(
        await admin
          .from("assignment_groups_members")
          .select("assignment_group_id")
          .eq("assignment_id", assignmentId)
          .eq("profile_id", profileId)
          .maybeSingle(),
        "Group lookup"
      );
      return row?.assignment_group_id ?? null;
    },
    async getRepository(repositoryId) {
      return check(
        await admin.from("repositories").select(REPOSITORY_COLUMNS).eq("id", repositoryId).maybeSingle(),
        "Repository lookup"
      ) as RepositoryRow | null;
    },
    async findRepository(assignmentId, profileId, groupId) {
      const query = admin.from("repositories").select(REPOSITORY_COLUMNS).eq("assignment_id", assignmentId);
      const scoped = groupId !== null ? query.eq("assignment_group_id", groupId) : query.eq("profile_id", profileId);
      return check(await scoped.maybeSingle(), "Repository lookup") as RepositoryRow | null;
    },
    async getCoderAccount(userId, instanceUrl) {
      return check(
        await admin
          .from("coder_accounts")
          .select("coder_user_id, coder_username")
          .eq("user_id", userId)
          .eq("instance_url", instanceUrl)
          .maybeSingle(),
        "Coder account lookup"
      );
    },
    async saveCoderAccount(row) {
      check(
        await admin.from("coder_accounts").upsert(row, { onConflict: "user_id,instance_url" }),
        "Coder account save"
      );
    },
    async reserveWorkspace(row) {
      check(
        await admin
          .from("coder_workspaces")
          .upsert(row, { onConflict: "user_id,repository_id,instance_url", ignoreDuplicates: true }),
        "Workspace row insert"
      );
      const stored = await this.getWorkspaceRow(row.user_id, row.repository_id, row.instance_url);
      if (!stored) throw new Error("Workspace row missing after insert");
      return stored;
    },
    async markCurrentWorkspace(row) {
      const now = new Date().toISOString();
      check(
        await admin
          .from("coder_workspaces")
          .update({ superseded_at: now, updated_at: now })
          .eq("user_id", row.user_id)
          .eq("assignment_id", row.assignment_id)
          .eq("instance_url", row.instance_url)
          .neq("id", row.id)
          .is("superseded_at", null),
        "Workspace rows supersede"
      );
      check(
        await admin
          .from("coder_workspaces")
          .update({ superseded_at: null, updated_at: now })
          .eq("id", row.id)
          .not("superseded_at", "is", null),
        "Workspace row unsupersede"
      );
    },
    async getWorkspaceRow(userId, repositoryId, instanceUrl) {
      return check(
        await admin
          .from("coder_workspaces")
          .select(WORKSPACE_COLUMNS)
          .eq("user_id", userId)
          .eq("repository_id", repositoryId)
          .eq("instance_url", instanceUrl)
          .maybeSingle(),
        "Workspace row lookup"
      ) as WorkspaceRow | null;
    },
    async updateWorkspaceRow(id, patch) {
      check(
        await admin
          .from("coder_workspaces")
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq("id", id),
        "Workspace row update"
      );
    },
    async claimRestart(id, staleBefore) {
      const now = new Date().toISOString();
      const claimed = check(
        await admin
          .from("coder_workspaces")
          .update({
            restart_started_at: now,
            restart_phase: "stopping",
            restart_token: crypto.randomUUID(),
            updated_at: now
          })
          .eq("id", id)
          .or(`restart_started_at.is.null,restart_started_at.lt."${staleBefore}"`)
          .select("restart_token"),
        "Workspace restart claim"
      );
      return claimed?.[0]?.restart_token ?? null;
    },
    async takeRestartStart(id, token) {
      // One UPDATE: Postgres rechecks the WHERE on the row a concurrent winner left, so one call wins.
      const now = new Date().toISOString();
      const taken = check(
        await admin
          .from("coder_workspaces")
          .update({
            restart_started_at: now,
            restart_phase: "starting",
            restart_token: crypto.randomUUID(),
            updated_at: now
          })
          .eq("id", id)
          .eq("restart_token", token)
          .eq("restart_phase", "stopping")
          .select("restart_token"),
        "Workspace restart start claim"
      );
      return taken?.[0]?.restart_token ?? null;
    },
    async releaseRestart(id, token) {
      check(
        await admin
          .from("coder_workspaces")
          .update({
            restart_started_at: null,
            restart_phase: null,
            restart_token: null,
            updated_at: new Date().toISOString()
          })
          .eq("id", id)
          .eq("restart_token", token),
        "Workspace restart claim release"
      );
    },
    async deletionDate(workspaceRowId) {
      return check(
        await admin.rpc("coder_workspace_deletion_date", { p_workspace_id: workspaceRowId }),
        "Deletion date"
      );
    }
  };
}

/**
 * The signed-in caller, the request, and everything the workspace functions need. Every Supabase
 * and Coder call made with them, the sign-in check included, is cut off by the budget.
 */
export async function workspaceRequestContext(
  req: Request,
  budget: Budget
): Promise<{ deps: Deps; caller: Caller; request: WorkspaceOpenRequest }> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new SecurityError("No token provided");
  const body = await readJsonObjectBody(req);
  const request: WorkspaceOpenRequest = {
    assignment_id: body.assignment_id as number,
    repository_id:
      body.repository_id === undefined || body.repository_id === null ? undefined : (body.repository_id as number)
  };

  const anon = budgetClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, budget, {
    Authorization: authHeader
  });
  const { data, error } = await anon.auth.getUser(authHeader.replace("Bearer ", ""));
  assertAuthLookupSucceeded(error);
  if (!data?.user?.email) throw new SecurityError("User not found");

  const config = coderConfig();
  const forgejoUrl = Deno.env.get("FORGEJO_URL")?.replace(/\/+$/, "");
  if (!config || !forgejoUrl) {
    throw new UserVisibleError("Coder workspaces are not set up on this deployment", 503);
  }
  const admin = budgetClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, budget);
  const name = check(
    await admin.from("users").select("name").eq("user_id", data.user.id).maybeSingle(),
    "User lookup"
  )?.name;
  return {
    deps: { db: supabaseWorkspaceDb(admin), coder: { ...config, fetch: budgetFetch(budget) }, forgejoUrl, budget },
    caller: { userId: data.user.id, email: data.user.email, name: name ?? null },
    request
  };
}
