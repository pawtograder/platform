/**
 * #1010: the Repository Status actions follow manage_student_repositories
 * (20261120140200_repository_status_by_capability.sql).
 *
 * retry_repository_creation, fix_assignment_repo_permissions and
 * cleanup_individual_repositories_for_assignment need manage_student_repositories in the class. The default
 * instructor role holds it; the default grader role doesn't. Sync (queue_repository_syncs) is not
 * part of this and still follows manage_assignments.
 *
 * Nothing here reaches GitHub. Every fixture repository is a row only: not ready on GitHub, with a
 * creation_error so the repo reconciler leaves it alone, on an assignment whose repo_mode is "none"
 * (nothing creates repositories for it). So:
 *   - retry_repository_creation queues nothing and writes its "no longer creates GitHub
 *     repositories" error, which shows the call got past the permission check;
 *   - fix_assignment_repo_permissions skips the repository as not ready;
 *   - cleanup_individual_repositories_for_assignment skips the archive (the repository's org isn't
 *     the class's org) and deletes the row.
 *
 * Default per-PR lane; lives at tests/e2e/ root so it isn't testIgnore'd.
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

const FIXTURE_ERROR = "E2E fixture: never created on GitHub";

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };

function expectRefused({ error }: RpcResult, what: string) {
  expect(error?.code, `${what} must be refused with 42501`).toBe("42501");
}

test.describe("Repository Status actions follow manage_student_repositories (#1010)", () => {
  let classS: Awaited<ReturnType<typeof createClass>>;
  let otherClass: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let plainGrader: TestingUser;
  let headTa: TestingUser;
  let syncTa: TestingUser;
  let student: TestingUser;
  let otherStudent: TestingUser;
  let unique = 0;

  async function customRole(name: string, capability: string, user: TestingUser) {
    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: classS.id, name })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    expect((await supabase.from("role_capabilities").insert({ role_id: role!.id, capability })).error).toBeNull();
    expect(
      (
        await supabase
          .from("user_roles")
          .update({ class_role_id: role!.id })
          .eq("user_id", user.user_id)
          .eq("class_id", classS.id)
      ).error
    ).toBeNull();
  }

  /** An assignment with repo_mode "none", so nothing will create or sync its repositories. */
  async function newAssignment(class_id: number, slug: string) {
    return insertAssignment({
      class_id,
      due_date: addDays(new Date(), 14).toISOString(),
      release_date: addDays(new Date(), 7).toISOString(),
      repo_mode: "none",
      assignment_slug: `e2e-repo-status-${slug}-${Date.now().toString(36)}`
    });
  }

  /** An individual repository row that was never created on GitHub. */
  async function newRepository(class_id: number, assignment_id: number, profile_id: string) {
    unique++;
    const { data, error } = await supabase
      .from("repositories")
      .insert({
        class_id,
        assignment_id,
        profile_id,
        repository: `not-actually/e2e-repo-status-${Date.now().toString(36)}-${unique}`,
        creation_error: FIXTURE_ERROR
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id;
  }

  async function repository(id: number) {
    const { data, error } = await supabase.from("repositories").select("id, creation_error").eq("id", id);
    expect(error).toBeNull();
    return data?.[0] ?? null;
  }

  test.beforeAll(async () => {
    classS = await createClass({ name: "E2E Repository Status By Capability S" });
    otherClass = await createClass({ name: "E2E Repository Status By Capability Other" });
    instructor = await createUserInClass({ role: "instructor", class_id: classS.id });
    plainGrader = await createUserInClass({ role: "grader", class_id: classS.id });
    headTa = await createUserInClass({ role: "grader", class_id: classS.id });
    syncTa = await createUserInClass({ role: "grader", class_id: classS.id });
    student = await createUserInClass({ role: "student", class_id: classS.id });
    otherStudent = await createUserInClass({ role: "student", class_id: otherClass.id });

    // A Head TA: a custom role with manage_student_repositories turned on.
    await customRole("Repository TA", "manage_student_repositories", headTa);
    // A custom role with manage_assignments only, for Sync.
    await customRole("Assignment TA", "manage_assignments", syncTa);
  });

  test("a default grader is refused on all three, and nothing changes", async () => {
    const assignment = await newAssignment(classS.id, "grader");
    const repoId = await newRepository(classS.id, assignment.id, student.private_profile_id);
    const client = await createAuthenticatedClient(plainGrader);

    expectRefused(
      await client.rpc("retry_repository_creation", { p_repository_id: repoId }),
      "retry_repository_creation"
    );
    expectRefused(
      await client.rpc("fix_assignment_repo_permissions", { p_class_id: classS.id, p_assignment_id: assignment.id }),
      "fix_assignment_repo_permissions"
    );
    expectRefused(
      await client.rpc("cleanup_individual_repositories_for_assignment", {
        p_class_id: classS.id,
        p_assignment_id: assignment.id
      }),
      "cleanup_individual_repositories_for_assignment"
    );

    const after = await repository(repoId);
    expect(after, "the repository is still there").not.toBeNull();
    expect(after!.creation_error, "retry didn't run").toBe(FIXTURE_ERROR);
  });

  test("manage_assignments alone doesn't allow them", async () => {
    const assignment = await newAssignment(classS.id, "sync-ta");
    const repoId = await newRepository(classS.id, assignment.id, student.private_profile_id);
    const client = await createAuthenticatedClient(syncTa);

    expectRefused(
      await client.rpc("retry_repository_creation", { p_repository_id: repoId }),
      "retry_repository_creation"
    );
    expectRefused(
      await client.rpc("fix_assignment_repo_permissions", { p_class_id: classS.id, p_assignment_id: assignment.id }),
      "fix_assignment_repo_permissions"
    );
    expectRefused(
      await client.rpc("cleanup_individual_repositories_for_assignment", {
        p_class_id: classS.id,
        p_assignment_id: assignment.id
      }),
      "cleanup_individual_repositories_for_assignment"
    );
    expect(await repository(repoId)).not.toBeNull();
  });

  for (const who of ["Head TA with manage_student_repositories", "instructor"] as const) {
    test(`a ${who} can retry, fix permissions and clean up`, async () => {
      const user = who === "instructor" ? instructor : headTa;
      const client = await createAuthenticatedClient(user);
      const assignment = await newAssignment(classS.id, who === "instructor" ? "instructor" : "head-ta");
      const repoId = await newRepository(classS.id, assignment.id, student.private_profile_id);

      // Retry: nothing is queued for a repo_mode "none" assignment, so the function writes its own
      // error in place of the fixture's.
      const retry = await client.rpc("retry_repository_creation", { p_repository_id: repoId });
      expect(retry.error).toBeNull();
      expect(retry.data, "nothing was queued").toBeNull();
      expect((await repository(repoId))!.creation_error).toMatch(/no longer creates GitHub repositories/);

      const fix = await client.rpc("fix_assignment_repo_permissions", {
        p_class_id: classS.id,
        p_assignment_id: assignment.id
      });
      expect(fix.error).toBeNull();
      const fixSummary = (fix.data as { summary: Record<string, number> }).summary;
      expect(fixSummary.total).toBe(1);
      expect(fixSummary.skipped_not_ready).toBe(1);
      expect(fixSummary.enqueued_sync).toBe(0);

      const cleanup = await client.rpc("cleanup_individual_repositories_for_assignment", {
        p_class_id: classS.id,
        p_assignment_id: assignment.id
      });
      expect(cleanup.error).toBeNull();
      const cleanupSummary = (cleanup.data as { summary: Record<string, number> }).summary;
      expect(cleanupSummary.repositories_deleted).toBe(1);
      expect(cleanupSummary.repositories_enqueued_for_archive).toBe(0);
      expect(await repository(repoId), "the repository row is gone").toBeNull();
    });
  }

  test("manage_student_repositories in one class doesn't reach another class", async () => {
    const otherAssignment = await newAssignment(otherClass.id, "other");
    const otherRepoId = await newRepository(otherClass.id, otherAssignment.id, otherStudent.private_profile_id);
    const client = await createAuthenticatedClient(headTa);

    // The other class named directly. retry_repository_creation reads the class from the row.
    expectRefused(
      await client.rpc("retry_repository_creation", { p_repository_id: otherRepoId }),
      "retry on another class's repository"
    );
    expectRefused(
      await client.rpc("fix_assignment_repo_permissions", {
        p_class_id: otherClass.id,
        p_assignment_id: otherAssignment.id
      }),
      "fix permissions in another class"
    );
    expectRefused(
      await client.rpc("cleanup_individual_repositories_for_assignment", {
        p_class_id: otherClass.id,
        p_assignment_id: otherAssignment.id
      }),
      "cleanup in another class"
    );

    // The Head TA's own class with the other class's assignment: nothing of the other class is touched.
    const fix = await client.rpc("fix_assignment_repo_permissions", {
      p_class_id: classS.id,
      p_assignment_id: otherAssignment.id
    });
    expect(fix.error).toBeNull();
    expect((fix.data as { summary: Record<string, number> }).summary.total).toBe(0);
    const cleanup = await client.rpc("cleanup_individual_repositories_for_assignment", {
      p_class_id: classS.id,
      p_assignment_id: otherAssignment.id
    });
    expect(cleanup.error?.message ?? "").toContain("Assignment not found for this course");

    const after = await repository(otherRepoId);
    expect(after, "the other class's repository is still there").not.toBeNull();
    expect(after!.creation_error).toBe(FIXTURE_ERROR);
  });

  test("Sync still follows manage_assignments", async () => {
    const assignment = await newAssignment(classS.id, "sync");
    const repoId = await newRepository(classS.id, assignment.id, student.private_profile_id);

    // The repository isn't ready on GitHub, so an allowed call queues nothing.
    const synced = await (
      await createAuthenticatedClient(syncTa)
    ).rpc("queue_repository_syncs", { p_repository_ids: [repoId] });
    expect(synced.error, "a manage_assignments holder can queue syncs").toBeNull();
    expect((synced.data as { queued_count: number }).queued_count).toBe(0);

    const refused = await (
      await createAuthenticatedClient(headTa)
    ).rpc("queue_repository_syncs", { p_repository_ids: [repoId] });
    expect(refused.error?.message ?? "", "manage_student_repositories doesn't allow Sync").toContain(
      "manage_assignments is required"
    );
  });
});
