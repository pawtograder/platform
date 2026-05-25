import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  getTestRunPrefix,
  insertAssignment,
  supabase
} from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";

// Tests for the create_no_repo_submission RPC introduced in PR #781
// (migration: 20260522130002_assignment-no-repo-submission.sql).
//
// NOTE: This test exercises the RPC directly via an authenticated Supabase
// client. We do NOT actually upload files to the submission-files storage
// bucket — the RPC trusts the caller for `storage_key` values and only
// inserts metadata rows. The companion form UI / storage-upload flow is
// covered by a separate E2E test (issue #10).

type NoRepoSubmissionFile = {
  name: string;
  storage_key: string;
  file_size: number;
  mime_type: string;
};

/** Local helper: call the RPC via the given (student-scoped) authenticated client. */
async function callRpc(client: SupabaseClient<Database>, assignmentId: number, files: NoRepoSubmissionFile[]) {
  // The wrapper in lib/edgeFunctions.ts (createNoRepoSubmission) throws on
  // error, but we want to inspect the raw error in negative tests, so call
  // the RPC directly here.
  return (await (client.rpc as CallableFunction)("create_no_repo_submission", {
    p_assignment_id: assignmentId,
    p_files: files
  })) as { data: number | null; error: { message: string; code?: string } | null };
}

test.describe.configure({ mode: "serial" });

test.describe("create_no_repo_submission RPC (PR #781)", () => {
  test.describe.configure({ timeout: 180_000 });

  // getTestRunPrefix() embeds the current date with "/" and ":" — fine for slugs
  // displayed back to the user, but those are not valid local-part characters in
  // an RFC-5322 email and Supabase auth rejects them. Use a clean alphanumeric
  // identifier for emails / slugs, keep the prefix for human-readable titles.
  const RUN_PREFIX = getTestRunPrefix();
  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  let classId: number;
  let otherClassId: number;
  let studentA: TestingUser;
  let studentB: TestingUser;
  let studentC: TestingUser;
  let studentInOtherClass: TestingUser;
  let groupStudentA: TestingUser;
  let groupStudentB: TestingUser;

  // Assignments created lazily per scenario so we can vary repo_mode / release.
  let happyPathAssignmentId: number;
  let happyPathClassId: number;

  test.beforeAll(async () => {
    const cls = await createClass({ name: `E2E No-Repo Submission ${RUN_PREFIX}` });
    classId = cls.id;
    const other = await createClass({ name: `E2E No-Repo Other Class ${RUN_PREFIX}` });
    otherClassId = other.id;

    studentA = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `NoRepo Student A ${RUN_PREFIX}`,
      email: `e2e-norepo-a-${SAFE_ID}@pawtograder.net`
    });
    studentB = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `NoRepo Student B ${RUN_PREFIX}`,
      email: `e2e-norepo-b-${SAFE_ID}@pawtograder.net`
    });
    studentC = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `NoRepo Student C ${RUN_PREFIX}`,
      email: `e2e-norepo-c-${SAFE_ID}@pawtograder.net`
    });
    studentInOtherClass = await createUserInClass({
      role: "student",
      class_id: otherClassId,
      name: `NoRepo Outsider ${RUN_PREFIX}`,
      email: `e2e-norepo-outsider-${SAFE_ID}@pawtograder.net`
    });
    groupStudentA = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `NoRepo Group A ${RUN_PREFIX}`,
      email: `e2e-norepo-grp-a-${SAFE_ID}@pawtograder.net`
    });
    groupStudentB = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `NoRepo Group B ${RUN_PREFIX}`,
      email: `e2e-norepo-grp-b-${SAFE_ID}@pawtograder.net`
    });

    // Happy-path assignment (repo_mode='none', released yesterday).
    const happyAssignment = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `NoRepo Happy ${RUN_PREFIX}`,
      assignment_slug: `e2e-norepo-happy-${SAFE_ID}`,
      repo_mode: "none"
    });
    happyPathAssignmentId = happyAssignment.id;
    happyPathClassId = classId;
  });

  test("happy path: single student creates an upload submission with one file", async () => {
    const studentClient = await createAuthenticatedClient(studentA);

    // Note: we don't actually upload to the submission-files bucket — the RPC
    // only writes metadata. The companion UI test (#10) covers the upload step.
    const { data, error } = await callRpc(studentClient, happyPathAssignmentId, [
      {
        name: "essay.pdf",
        storage_key: `test/${RUN_PREFIX}/essay.pdf`,
        file_size: 12345,
        mime_type: "application/pdf"
      }
    ]);

    expect(error).toBeNull();
    expect(typeof data).toBe("number");
    expect(Number.isFinite(data)).toBe(true);
    const submissionId = data!;

    const { data: submission, error: submissionErr } = await supabase
      .from("submissions")
      .select("*")
      .eq("id", submissionId)
      .single();
    expect(submissionErr).toBeNull();
    expect(submission).not.toBeNull();
    // submitted_via is added to submissions by PR #781 but the generated types
    // are stale w.r.t. that migration (it lives on assignments in the .d.ts),
    // so cast through unknown to read it.
    expect((submission as unknown as { submitted_via: string }).submitted_via).toBe("upload");
    expect(submission!.repository).toBeNull();
    expect(submission!.sha).toBeNull();
    expect(submission!.is_active).toBe(true);
    expect(submission!.ordinal).toBe(1);
    expect(submission!.run_attempt).toBe(1);
    expect(submission!.run_number).toBe(1);
    expect(submission!.profile_id).toBe(studentA.private_profile_id);
    expect(submission!.assignment_group_id).toBeNull();
    expect(submission!.class_id).toBe(happyPathClassId);
    expect(submission!.assignment_id).toBe(happyPathAssignmentId);

    const { data: files, error: filesErr } = await supabase
      .from("submission_files")
      .select("*")
      .eq("submission_id", submissionId);
    expect(filesErr).toBeNull();
    expect(files).toHaveLength(1);
    const file = files![0];
    expect(file.name).toBe("essay.pdf");
    expect(file.storage_key).toBe(`test/${RUN_PREFIX}/essay.pdf`);
    expect(Number(file.file_size)).toBe(12345);
    expect(file.mime_type).toBe("application/pdf");
    expect(file.is_binary).toBe(true);
    expect(file.profile_id).toBe(studentA.private_profile_id);
    expect(file.assignment_group_id).toBeNull();
  });

  test("empty p_files is allowed: creates submission with zero file rows", async () => {
    const studentClient = await createAuthenticatedClient(studentB);

    const { data, error } = await callRpc(studentClient, happyPathAssignmentId, []);
    expect(error).toBeNull();
    expect(typeof data).toBe("number");
    const submissionId = data!;

    const { data: submission } = await supabase
      .from("submissions")
      .select("id, is_active, ordinal, profile_id, assignment_group_id")
      .eq("id", submissionId)
      .single();
    expect(submission).not.toBeNull();
    expect(submission!.is_active).toBe(true);
    expect(submission!.profile_id).toBe(studentB.private_profile_id);
    expect(submission!.assignment_group_id).toBeNull();

    // Also assert submitted_via via a separate select (generated types lag).
    const { data: viaRow } = await supabase.from("submissions").select("*").eq("id", submissionId).single();
    expect((viaRow as unknown as { submitted_via: string }).submitted_via).toBe("upload");

    const { data: files } = await supabase.from("submission_files").select("id").eq("submission_id", submissionId);
    expect(files).toHaveLength(0);
  });

  test("second submission deactivates the prior and increments ordinal", async () => {
    // Reuse student A from the happy-path test.
    const studentClient = await createAuthenticatedClient(studentA);

    // Snapshot the prior active submission for student A on this assignment.
    const { data: priorActive } = await supabase
      .from("submissions")
      .select("id, ordinal")
      .eq("assignment_id", happyPathAssignmentId)
      .eq("profile_id", studentA.private_profile_id)
      .eq("is_active", true)
      .single();
    expect(priorActive).not.toBeNull();
    const priorId = priorActive!.id;
    const priorOrdinal = priorActive!.ordinal;

    const { data: newId, error } = await callRpc(studentClient, happyPathAssignmentId, [
      {
        name: "revised-essay.pdf",
        storage_key: `test/${RUN_PREFIX}/revised-essay.pdf`,
        file_size: 9876,
        mime_type: "application/pdf"
      }
    ]);
    expect(error).toBeNull();
    expect(typeof newId).toBe("number");

    // Old one is now inactive.
    const { data: oldRow } = await supabase.from("submissions").select("is_active, ordinal").eq("id", priorId).single();
    expect(oldRow!.is_active).toBe(false);
    expect(oldRow!.ordinal).toBe(priorOrdinal);

    // New one is active with ordinal+1.
    const { data: newRow } = await supabase
      .from("submissions")
      .select("is_active, ordinal, run_number, run_attempt, profile_id")
      .eq("id", newId!)
      .single();
    expect(newRow!.is_active).toBe(true);
    expect(newRow!.ordinal).toBe(priorOrdinal + 1);
    expect(newRow!.run_number).toBe(priorOrdinal + 1);
    expect(newRow!.run_attempt).toBe(1);
    expect(newRow!.profile_id).toBe(studentA.private_profile_id);
  });

  test("pre-release: assignment not yet released blocks the RPC", async () => {
    const assignment = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 14).toISOString(),
      release_date: addDays(new Date(), 1).toUTCString(),
      name: `NoRepo Future ${RUN_PREFIX}`,
      assignment_slug: `e2e-norepo-future-${SAFE_ID}`,
      repo_mode: "none"
    });

    const studentClient = await createAuthenticatedClient(studentC);
    const { data, error } = await callRpc(studentClient, assignment.id, []);
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("not yet released");
  });

  test("wrong repo_mode: template_only_staff rejects student uploads", async () => {
    // Default repo_mode is template_only_staff.
    const assignment = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 7).toISOString(),
      name: `NoRepo TemplateOnly ${RUN_PREFIX}`,
      assignment_slug: `e2e-norepo-tos-${SAFE_ID}`
    });

    const studentClient = await createAuthenticatedClient(studentC);
    const { data, error } = await callRpc(studentClient, assignment.id, []);
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("does not accept student uploads");
  });

  test("wrong repo_mode: no_submission falls through to upload-rejection", async () => {
    const assignment = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 7).toISOString(),
      name: `NoRepo NoSubmission ${RUN_PREFIX}`,
      assignment_slug: `e2e-norepo-ns-${SAFE_ID}`,
      repo_mode: "no_submission"
    });

    const studentClient = await createAuthenticatedClient(studentC);
    const { data, error } = await callRpc(studentClient, assignment.id, []);
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("does not accept student uploads");
    expect(error!.message).toContain("repo_mode=no_submission");
  });

  test("wrong repo_mode: template_with_student_forks rejects upload", async () => {
    const assignment = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 7).toISOString(),
      name: `NoRepo Forks ${RUN_PREFIX}`,
      assignment_slug: `e2e-norepo-fork-${SAFE_ID}`,
      repo_mode: "template_with_student_forks"
    });

    const studentClient = await createAuthenticatedClient(studentC);
    const { data, error } = await callRpc(studentClient, assignment.id, []);
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("does not accept student uploads");
  });

  test("auth gating: anonymous client gets 42501 / authentication error", async () => {
    const anonClient = createClient<Database>(
      process.env.SUPABASE_URL!,
      (process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!
    );
    const { data, error } = (await (anonClient.rpc as CallableFunction)("create_no_repo_submission", {
      p_assignment_id: happyPathAssignmentId,
      p_files: []
    })) as { data: number | null; error: { message: string; code?: string } | null };

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    // Either the explicit "Must be authenticated" raise OR a 42501 code from PostgREST.
    const msgOrCode = `${error!.message} ${error!.code ?? ""}`.toLowerCase();
    expect(msgOrCode.includes("authenticated") || msgOrCode.includes("42501") || msgOrCode.includes("auth")).toBe(true);
  });

  test("auth gating: authenticated user from a different class is rejected", async () => {
    const outsiderClient = await createAuthenticatedClient(studentInOtherClass);
    const { data, error } = await callRpc(outsiderClient, happyPathAssignmentId, []);
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("not an active student in class");
  });

  test("group submission: stores both profile_id and assignment_group_id, deactivates prior on second member's submit", async () => {
    const groupAssignment = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `NoRepo Group ${RUN_PREFIX}`,
      assignment_slug: `e2e-norepo-group-${SAFE_ID}`,
      repo_mode: "none",
      group_config: "groups",
      min_group_size: 2,
      max_group_size: 3,
      group_formation_deadline: addDays(new Date(), 7).toISOString()
    });

    const { data: group, error: groupErr } = await supabase
      .from("assignment_groups")
      .insert({
        assignment_id: groupAssignment.id,
        class_id: classId,
        name: `e2e-norepo-group-${RUN_PREFIX}`
      })
      .select("id")
      .single();
    expect(groupErr).toBeNull();
    const groupId = group!.id;

    const { error: membersErr } = await supabase.from("assignment_groups_members").insert([
      {
        assignment_group_id: groupId,
        assignment_id: groupAssignment.id,
        class_id: classId,
        added_by: groupStudentA.private_profile_id,
        profile_id: groupStudentA.private_profile_id
      },
      {
        assignment_group_id: groupId,
        assignment_id: groupAssignment.id,
        class_id: classId,
        added_by: groupStudentA.private_profile_id,
        profile_id: groupStudentB.private_profile_id
      }
    ]);
    expect(membersErr).toBeNull();

    // Student A submits.
    const clientA = await createAuthenticatedClient(groupStudentA);
    const { data: subA, error: subAErr } = await callRpc(clientA, groupAssignment.id, [
      {
        name: "groupwork.pdf",
        storage_key: `test/${RUN_PREFIX}/group-a.pdf`,
        file_size: 1000,
        mime_type: "application/pdf"
      }
    ]);
    expect(subAErr).toBeNull();
    expect(typeof subA).toBe("number");

    const { data: rowA } = await supabase
      .from("submissions")
      .select("profile_id, assignment_group_id, is_active, ordinal")
      .eq("id", subA!)
      .single();
    // Per migration lines 116-122: submission stores both profile_id (caller's
    // private_profile_id) AND assignment_group_id (the group).
    expect(rowA!.profile_id).toBe(groupStudentA.private_profile_id);
    expect(rowA!.assignment_group_id).toBe(groupId);
    expect(rowA!.is_active).toBe(true);
    expect(rowA!.ordinal).toBe(1);

    // Student B (same group) submits — A's prior should flip inactive.
    const clientB = await createAuthenticatedClient(groupStudentB);
    const { data: subB, error: subBErr } = await callRpc(clientB, groupAssignment.id, [
      {
        name: "groupwork-v2.pdf",
        storage_key: `test/${RUN_PREFIX}/group-b.pdf`,
        file_size: 2000,
        mime_type: "application/pdf"
      }
    ]);
    expect(subBErr).toBeNull();
    expect(typeof subB).toBe("number");

    // A's submission now inactive.
    const { data: rowA2 } = await supabase.from("submissions").select("is_active").eq("id", subA!).single();
    expect(rowA2!.is_active).toBe(false);

    // B's submission active, group scoped, ordinal=2.
    const { data: rowB } = await supabase
      .from("submissions")
      .select("profile_id, assignment_group_id, is_active, ordinal")
      .eq("id", subB!)
      .single();
    expect(rowB!.profile_id).toBe(groupStudentB.private_profile_id);
    expect(rowB!.assignment_group_id).toBe(groupId);
    expect(rowB!.is_active).toBe(true);
    expect(rowB!.ordinal).toBe(2);
  });

  test("concurrent submissions are serialized by the advisory lock", async () => {
    const concurrentAssignment = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `NoRepo Concurrent ${RUN_PREFIX}`,
      assignment_slug: `e2e-norepo-concurrent-${SAFE_ID}`,
      repo_mode: "none"
    });

    // Fresh student so the assignment has no prior submissions.
    const concurrencyStudent = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `NoRepo Concurrent Student ${RUN_PREFIX}`,
      email: `e2e-norepo-conc-${SAFE_ID}@pawtograder.net`
    });

    // Two independent authenticated clients for the same user (each holds its
    // own session); kicking the RPCs off in parallel should still resolve via
    // pg_advisory_xact_lock without producing dual-active rows or duplicate
    // ordinals.
    const client1 = await createAuthenticatedClient(concurrencyStudent);
    const client2 = await createAuthenticatedClient(concurrencyStudent);

    const [r1, r2] = await Promise.all([
      callRpc(client1, concurrentAssignment.id, [
        {
          name: "race-1.pdf",
          storage_key: `test/${RUN_PREFIX}/race-1.pdf`,
          file_size: 100,
          mime_type: "application/pdf"
        }
      ]),
      callRpc(client2, concurrentAssignment.id, [
        {
          name: "race-2.pdf",
          storage_key: `test/${RUN_PREFIX}/race-2.pdf`,
          file_size: 200,
          mime_type: "application/pdf"
        }
      ])
    ]);

    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    expect(typeof r1.data).toBe("number");
    expect(typeof r2.data).toBe("number");

    const { data: rows, error: rowsErr } = await supabase
      .from("submissions")
      .select("id, ordinal, is_active")
      .eq("assignment_id", concurrentAssignment.id)
      .eq("profile_id", concurrencyStudent.private_profile_id)
      .order("ordinal", { ascending: true });
    expect(rowsErr).toBeNull();
    expect(rows).toHaveLength(2);
    expect(rows!.map((r) => r.ordinal)).toEqual([1, 2]);
    const active = rows!.filter((r) => r.is_active);
    expect(active).toHaveLength(1);
    expect(active[0].ordinal).toBe(2);
    const inactive = rows!.filter((r) => !r.is_active);
    expect(inactive).toHaveLength(1);
    expect(inactive[0].ordinal).toBe(1);
  });
});
