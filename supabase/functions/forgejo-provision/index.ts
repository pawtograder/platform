/**
 * POC: provision a Forgejo class. Creates a Forgejo account for every enrolled person who lacks
 * one, puts them on the course org's students or staff team, and (when assignment_id is given)
 * creates each student's private repo from the assignment's template.
 *
 * Nobody accepts an invitation: Pawtograder owns the Forgejo instance and adds people directly.
 * A repository row is marked ready only after Forgejo reports the student's access back, so the
 * assignment page never links to a repo the student cannot open yet.
 *
 * In production this belongs in the existing async worker, driven by enrollment and release
 * triggers. Here it is one synchronous call so the flow can be exercised end to end.
 *
 * Request:  { class_id: number, assignment_id?: number }
 * Response: { accounts_created: number, repos: { repository, login, permission, ready }[] }
 *
 * Authorization: instructor in the class.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import {
  addCollaborator,
  addTeamMember,
  createUserForPawtograderUser,
  ensureOrg,
  ensureTeam,
  forgejoUrl,
  generateRepoFromTemplate,
  getPermission
} from "../_shared/ForgejoWrapper.ts";
import {
  assertUserIsInstructor,
  readJsonObjectBody,
  SecurityError,
  UserVisibleError,
  wrapRequestHandler
} from "../_shared/HandlerUtils.ts";
import { REQUEST_SCOPED_AUTH_OPTIONS } from "../_shared/requestScopedAuthOptions.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";

export type ForgejoProvisionResponse = {
  accounts_created: number;
  repos: { repository: string; login: string; permission: string; ready: boolean }[];
};

async function handleRequest(req: Request, scope: Sentry.Scope): Promise<ForgejoProvisionResponse> {
  const body = await readJsonObjectBody(req);
  const classId = Number(body.class_id);
  const assignmentId = body.assignment_id === undefined ? null : Number(body.assignment_id);
  if (!Number.isInteger(classId)) {
    throw new UserVisibleError("class_id is required", 400);
  }
  scope?.setTag("class_id", String(classId));

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new SecurityError("Missing Authorization header");
  }
  await assertUserIsInstructor(classId, authHeader);

  const admin = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: REQUEST_SCOPED_AUTH_OPTIONS
  });

  const { data: klass, error: classError } = await admin
    .from("classes")
    .select("id, name, git_provider, forgejo_org")
    .eq("id", classId)
    .single();
  if (classError || !klass) {
    throw new UserVisibleError("Class not found", 404);
  }
  if (klass.git_provider !== "forgejo" || !klass.forgejo_org) {
    throw new UserVisibleError("This class does not use Forgejo", 400);
  }
  const org = klass.forgejo_org;
  const instance = forgejoUrl();

  await ensureOrg(org, klass.name ?? org);
  const studentsTeam = await ensureTeam(org, "students", "read");
  const staffTeam = await ensureTeam(org, "staff", "write");

  const { data: roles, error: rolesError } = await admin
    .from("user_roles")
    .select("user_id, role, private_profile_id, users(email, name)")
    .eq("class_id", classId)
    .eq("disabled", false);
  if (rolesError) {
    throw new Error(`Roster read failed: ${rolesError.message}`);
  }

  const { data: existingAccounts, error: accountsError } = await admin
    .from("git_accounts")
    .select("user_id, login")
    .eq("provider", "forgejo")
    .eq("instance_url", instance)
    .in(
      "user_id",
      (roles ?? []).map((r) => r.user_id)
    );
  if (accountsError) {
    throw new Error(`Account read failed: ${accountsError.message}`);
  }
  const loginByUser = new Map((existingAccounts ?? []).map((a) => [a.user_id, a.login]));

  let accountsCreated = 0;
  for (const role of roles ?? []) {
    let login = loginByUser.get(role.user_id);
    if (!login) {
      const email = role.users?.email;
      if (!email) {
        continue;
      }
      const user = await createUserForPawtograderUser({
        userId: role.user_id,
        email,
        fullName: role.users?.name ?? null
      });
      const { error } = await admin.from("git_accounts").insert({
        user_id: role.user_id,
        provider: "forgejo",
        instance_url: instance,
        remote_user_id: user.id,
        login: user.login
      });
      if (error) {
        throw new Error(`Could not record Forgejo account for ${role.user_id}: ${error.message}`);
      }
      login = user.login;
      loginByUser.set(role.user_id, login);
      accountsCreated++;
    }
    await addTeamMember(role.role === "student" ? studentsTeam.id : staffTeam.id, login);
  }

  const repos: ForgejoProvisionResponse["repos"] = [];
  if (assignmentId !== null) {
    const { data: assignment } = await admin
      .from("assignments")
      .select("id, slug, template_repo, group_config")
      .eq("id", assignmentId)
      .eq("class_id", classId)
      .single();
    if (!assignment?.template_repo || !assignment.slug) {
      throw new UserVisibleError("Assignment not found, or it has no template repo", 404);
    }
    if (assignment.group_config !== "individual") {
      throw new UserVisibleError("The Forgejo POC only provisions individual assignments", 400);
    }
    for (const role of roles ?? []) {
      const login = loginByUser.get(role.user_id);
      if (role.role !== "student" || !login || !role.private_profile_id) {
        continue;
      }
      const name = `${assignment.slug}-${login}`;
      const repository = `${org}/${name}`;
      await generateRepoFromTemplate(assignment.template_repo, org, name);
      await addCollaborator(repository, login, "write");
      const permission = await getPermission(repository, login);
      const ready = permission === "write" || permission === "admin";
      const { error } = await admin.from("repositories").upsert(
        {
          assignment_id: assignment.id,
          class_id: classId,
          profile_id: role.private_profile_id,
          repository,
          git_provider: "forgejo",
          is_github_ready: ready
        },
        { onConflict: "repository" }
      );
      if (error) {
        throw new Error(`Could not record ${repository}: ${error.message}`);
      }
      repos.push({ repository, login, permission, ready });
    }
  }

  return { accounts_created: accountsCreated, repos };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
