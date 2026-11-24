/**
 * Retry creation and Fix Permissions on Forgejo repositories
 * (20261124150100_repository_status_forgejo_guards.sql).
 *
 * forgejo-reconciler creates Forgejo repositories and manages access to them, so:
 *   - retry_repository_creation on a Forgejo row clears creation_error and writes no GitHub message;
 *   - fix_assignment_repo_permissions refuses a Forgejo assignment (0A000) and queues nothing, with or
 *     without a github_org on the class.
 *
 * Nothing here reaches GitHub or Forgejo: the assignments release in a week, and the repositories are rows
 * only. Default per-PR lane; lives at tests/e2e/ root so it isn't testIgnore'd.
 */
import { addDays } from "date-fns";
import { test, expect } from "../global-setup";
import {
  supabase,
  createClass,
  createUserInClass,
  createAuthenticatedClient,
  insertAssignment,
  type TestingUser
} from "./TestingUtils";

test.describe("Repository Status actions on Forgejo", () => {
  let classWithOrg: Awaited<ReturnType<typeof createClass>>;
  let classWithoutOrg: Awaited<ReturnType<typeof createClass>>;
  const instructors = new Map<number, TestingUser>();
  const students = new Map<number, TestingUser>();
  let unique = 0;

  async function forgejoAssignment(class_id: number) {
    return insertAssignment({
      class_id,
      due_date: addDays(new Date(), 14).toISOString(),
      release_date: addDays(new Date(), 7).toISOString(),
      git_provider: "forgejo",
      assignment_slug: `e2e-repo-status-forgejo-${Date.now().toString(36)}-${++unique}`
    });
  }

  async function forgejoRepository(class_id: number, assignment_id: number, extra: Record<string, unknown>) {
    const { data, error } = await supabase
      .from("repositories")
      .insert({
        class_id,
        assignment_id,
        profile_id: students.get(class_id)!.private_profile_id,
        repository: `e2e-ignore/repo-status-forgejo-${Date.now().toString(36)}-${++unique}`,
        git_provider: "forgejo",
        ...extra
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id;
  }

  async function permissionSyncsQueued(assignment_id: number) {
    const { count, error } = await supabase
      .from("api_gateway_calls")
      .select("id", { count: "exact", head: true })
      .like("debug_id", `fix-repo-permissions-${assignment_id}-%`);
    expect(error).toBeNull();
    return count;
  }

  test.beforeAll(async () => {
    classWithOrg = await createClass({ name: "E2E Repository Status Forgejo With Org" });
    classWithoutOrg = await createClass({ name: "E2E Repository Status Forgejo No Org" });
    expect((await supabase.from("classes").update({ github_org: null }).eq("id", classWithoutOrg.id)).error).toBeNull();
    for (const c of [classWithOrg, classWithoutOrg]) {
      // The RPC, not setCourseFeature: nothing here renders a page, so the Next cache needn't be revalidated.
      const flag = await supabase.rpc("merge_class_feature_as_service_role", {
        p_class_id: c.id,
        p_name: "cloud-workspaces",
        p_enabled: true
      });
      expect(flag.error).toBeNull();
      instructors.set(c.id, await createUserInClass({ role: "instructor", class_id: c.id }));
      students.set(c.id, await createUserInClass({ role: "student", class_id: c.id }));
    }
  });

  for (const which of ["with", "without"] as const) {
    test(`Fix Permissions refuses a Forgejo assignment and queues nothing (class ${which} a github_org)`, async () => {
      const course = which === "with" ? classWithOrg : classWithoutOrg;
      const assignment = await forgejoAssignment(course.id);
      await forgejoRepository(course.id, assignment.id, { is_github_ready: true });
      const client = await createAuthenticatedClient(instructors.get(course.id)!);

      const fix = await client.rpc("fix_assignment_repo_permissions", {
        p_class_id: course.id,
        p_assignment_id: assignment.id
      });
      expect(fix.error?.code).toBe("0A000");
      expect(fix.error?.message ?? "").toContain("forgejo-reconciler");
      expect(await permissionSyncsQueued(assignment.id)).toBe(0);
    });

    test(`Retry on a Forgejo row clears the error without a GitHub message (class ${which} a github_org)`, async () => {
      const course = which === "with" ? classWithOrg : classWithoutOrg;
      const assignment = await forgejoAssignment(course.id);
      const repoId = await forgejoRepository(course.id, assignment.id, {
        is_github_ready: false,
        creation_error: "E2E fixture: Forgejo creation failed"
      });
      const client = await createAuthenticatedClient(instructors.get(course.id)!);

      const retry = await client.rpc("retry_repository_creation", { p_repository_id: repoId });
      expect(retry.error).toBeNull();
      expect(retry.data, "nothing is queued for Forgejo").toBeNull();

      const { data, error } = await supabase
        .from("repositories")
        .select("creation_error, is_github_ready")
        .eq("id", repoId)
        .single();
      expect(error).toBeNull();
      expect(data!.creation_error, "the reconciler retries a not-ready row with no error").toBeNull();
      expect(data!.is_github_ready).toBe(false);
    });
  }
});
