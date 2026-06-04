import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import { randomBytes } from "node:crypto";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  getTestRunPrefix,
  insertAssignment,
  supabase
} from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";

type AssignmentWithRubric = Awaited<ReturnType<typeof insertAssignment>>;
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
        storage_key: `classes/${happyPathClassId}/profiles/${studentA.private_profile_id}/submissions/upload/files/essay.pdf`,
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
    expect(submission!.submitted_via).toBe("upload");
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
    expect(file.storage_key).toBe(
      `classes/${happyPathClassId}/profiles/${studentA.private_profile_id}/submissions/upload/files/essay.pdf`
    );
    expect(Number(file.file_size)).toBe(12345);
    expect(file.mime_type).toBe("application/pdf");
    expect(file.is_binary).toBe(true);
    expect(file.profile_id).toBe(studentA.private_profile_id);
    expect(file.assignment_group_id).toBeNull();
  });

  test("rejects a storage_key outside the caller's class/profile scope (S2)", async () => {
    const studentClient = await createAuthenticatedClient(studentA);

    // Key pointing at a different class's tree → rejected.
    const wrongClass = await callRpc(studentClient, happyPathAssignmentId, [
      {
        name: "evil.pdf",
        storage_key: `classes/99999999/profiles/${studentA.private_profile_id}/submissions/upload/files/evil.pdf`,
        file_size: 1,
        mime_type: "application/pdf"
      }
    ]);
    expect(wrongClass.error).not.toBeNull();
    expect(wrongClass.error!.message).toMatch(/outside this submission's scope/i);

    // Key in the right class but another profile's tree → also rejected.
    const wrongProfile = await callRpc(studentClient, happyPathAssignmentId, [
      {
        name: "evil2.pdf",
        storage_key: `classes/${happyPathClassId}/profiles/00000000-0000-0000-0000-000000000000/submissions/upload/files/evil2.pdf`,
        file_size: 1,
        mime_type: "application/pdf"
      }
    ]);
    expect(wrongProfile.error).not.toBeNull();

    // The rejected call must not leave an orphan file row (the RPC is one
    // transaction, so the raise rolls back the submission insert too).
    const { data: leftovers } = await supabase
      .from("submission_files")
      .select("id")
      .eq("storage_key", `classes/99999999/profiles/${studentA.private_profile_id}/submissions/upload/files/evil.pdf`);
    expect(leftovers ?? []).toHaveLength(0);
  });

  test("empty p_files is allowed: creates submission with zero file rows", async () => {
    const studentClient = await createAuthenticatedClient(studentB);

    const { data, error } = await callRpc(studentClient, happyPathAssignmentId, []);
    expect(error).toBeNull();
    expect(typeof data).toBe("number");
    const submissionId = data!;

    const { data: submission } = await supabase
      .from("submissions")
      .select("id, is_active, ordinal, profile_id, assignment_group_id, submitted_via")
      .eq("id", submissionId)
      .single();
    expect(submission).not.toBeNull();
    expect(submission!.is_active).toBe(true);
    expect(submission!.profile_id).toBe(studentB.private_profile_id);
    expect(submission!.assignment_group_id).toBeNull();
    expect(submission!.submitted_via).toBe("upload");

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
        storage_key: `classes/${happyPathClassId}/profiles/${studentA.private_profile_id}/submissions/upload/files/revised-essay.pdf`,
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
        storage_key: `classes/${classId}/profiles/${groupId}/submissions/upload/files/group-a.pdf`,
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
        storage_key: `classes/${classId}/profiles/${groupId}/submissions/upload/files/group-b.pdf`,
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
          storage_key: `classes/${classId}/profiles/${concurrencyStudent.private_profile_id}/submissions/upload/files/race-1.pdf`,
          file_size: 100,
          mime_type: "application/pdf"
        }
      ]),
      callRpc(client2, concurrentAssignment.id, [
        {
          name: "race-2.pdf",
          storage_key: `classes/${classId}/profiles/${concurrencyStudent.private_profile_id}/submissions/upload/files/race-2.pdf`,
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

// Full two-phase upload flow: create empty submission -> upload bytes to the
// submission-files bucket under the submission-id-scoped key -> attach file
// rows, then verify storage read RLS and end-to-end grading + release.
test.describe("Two-phase upload flow: storage + grading (PR #781)", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  const UPREFIX = getTestRunPrefix();
  const UID = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

  let upClassId: number;
  let upStudent: TestingUser;
  let otherStudent: TestingUser;
  let upInstructor: TestingUser;
  let upAssignment: AssignmentWithRubric;
  let submissionId: number;
  let storageKey: string;

  test.beforeAll(async () => {
    const cls = await createClass({ name: `E2E Upload Flow ${UPREFIX}` });
    upClassId = cls.id;
    upStudent = await createUserInClass({
      role: "student",
      class_id: upClassId,
      name: `Upload Student ${UPREFIX}`,
      email: `e2e-upload-stu-${UID}@pawtograder.net`
    });
    otherStudent = await createUserInClass({
      role: "student",
      class_id: upClassId,
      name: `Upload Other ${UPREFIX}`,
      email: `e2e-upload-other-${UID}@pawtograder.net`
    });
    upInstructor = await createUserInClass({
      role: "instructor",
      class_id: upClassId,
      name: `Upload Instructor ${UPREFIX}`,
      email: `e2e-upload-instr-${UID}@pawtograder.net`
    });
    upAssignment = await insertAssignment({
      class_id: upClassId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `Upload Flow ${UPREFIX}`,
      assignment_slug: `e2e-upload-${UID}`,
      repo_mode: "none"
    });
  });

  test("upload bytes + attach: file is readable by student and grader, not other students", async () => {
    const studentClient = await createAuthenticatedClient(upStudent);

    // Phase 1: create the empty active submission.
    const { data: sid, error: createErr } = await callRpc(studentClient, upAssignment.id, []);
    expect(createErr).toBeNull();
    expect(typeof sid).toBe("number");
    submissionId = sid!;

    // Phase 2a: upload the bytes to the submission-id-scoped key (owner-write RLS).
    const contents = `hello-upload-${UID}`;
    storageKey = `classes/${upClassId}/profiles/${upStudent.private_profile_id}/submissions/${submissionId}/files/essay.txt`;
    const { error: uploadErr } = await studentClient.storage
      .from("submission-files")
      .upload(storageKey, Buffer.from(contents), { contentType: "text/plain", upsert: true });
    expect(uploadErr).toBeNull();

    // Phase 2b: register the file row.
    const { error: attachErr } = await (studentClient.rpc as CallableFunction)("attach_no_repo_submission_files", {
      p_submission_id: submissionId,
      p_files: [{ name: "essay.txt", storage_key: storageKey, file_size: contents.length, mime_type: "text/plain" }]
    });
    expect(attachErr).toBeNull();

    const { data: files } = await supabase
      .from("submission_files")
      .select("name, storage_key, submission_id")
      .eq("submission_id", submissionId);
    expect(files).toHaveLength(1);
    expect(files![0].storage_key).toBe(storageKey);

    // The owner can read their bytes through a signed URL.
    const { data: studentSigned, error: studentSignErr } = await studentClient.storage
      .from("submission-files")
      .createSignedUrl(storageKey, 60);
    expect(studentSignErr).toBeNull();
    const studentResp = await fetch(studentSigned!.signedUrl);
    expect(studentResp.ok).toBe(true);
    expect(await studentResp.text()).toBe(contents);

    // A class grader (instructor) can read it too.
    const instructorClient = await createAuthenticatedClient(upInstructor);
    const { data: instrSigned, error: instrSignErr } = await instructorClient.storage
      .from("submission-files")
      .createSignedUrl(storageKey, 60);
    expect(instrSignErr).toBeNull();
    expect(instrSigned?.signedUrl).toBeTruthy();

    // An unrelated student cannot.
    const otherClient = await createAuthenticatedClient(otherStudent);
    const { data: otherSigned, error: otherSignErr } = await otherClient.storage
      .from("submission-files")
      .createSignedUrl(storageKey, 60);
    expect(otherSigned?.signedUrl ?? null).toBeNull();
    expect(otherSignErr).not.toBeNull();
  });

  test("attach rejects a storage_key whose submission_id segment doesn't match", async () => {
    const studentClient = await createAuthenticatedClient(upStudent);
    const badKey = `classes/${upClassId}/profiles/${upStudent.private_profile_id}/submissions/${submissionId + 999999}/files/evil.txt`;
    const { error } = await (studentClient.rpc as CallableFunction)("attach_no_repo_submission_files", {
      p_submission_id: submissionId,
      p_files: [{ name: "evil.txt", storage_key: badKey, file_size: 1, mime_type: "text/plain" }]
    });
    expect(error).not.toBeNull();
    expect(error!.message.toLowerCase()).toMatch(/outside this submission|scope/);
  });

  test("grade + release: student reads the released grade, hidden before release", async () => {
    const { data: subRow } = await supabase
      .from("submissions")
      .select("grading_review_id")
      .eq("id", submissionId)
      .single();
    const reviewId = subRow!.grading_review_id!;
    const studentClient = await createAuthenticatedClient(upStudent);

    // Before release the student cannot see a released grade.
    const { data: pre } = await studentClient
      .from("submission_reviews")
      .select("released, total_score")
      .eq("id", reviewId)
      .maybeSingle();
    expect(pre?.released ?? false).toBe(false);

    // Grade via a rubric-check comment (triggers the total_score recompute), then release.
    const gradingCheck = upAssignment.rubricChecks.find((c) => c.name === "Grading Review Check 2");
    expect(gradingCheck).toBeDefined();
    const { error: commentErr } = await supabase.from("submission_comments").insert({
      submission_id: submissionId,
      submission_review_id: reviewId,
      rubric_check_id: gradingCheck!.id,
      class_id: upClassId,
      author: upInstructor.private_profile_id,
      comment: "Upload submission graded",
      points: 8,
      released: true,
      eventually_visible: true,
      regrade_request_id: null
    });
    expect(commentErr).toBeNull();
    await new Promise((r) => setTimeout(r, 750));
    const { error: releaseErr } = await supabase
      .from("submission_reviews")
      .update({
        released: true,
        completed_at: new Date().toISOString(),
        completed_by: upInstructor.private_profile_id,
        grader: upInstructor.private_profile_id
      })
      .eq("id", reviewId);
    expect(releaseErr).toBeNull();

    // The student now sees the released grade.
    const { data: post, error: postErr } = await studentClient
      .from("submission_reviews")
      .select("released, total_score")
      .eq("id", reviewId)
      .single();
    expect(postErr).toBeNull();
    expect(post!.released).toBe(true);
    expect(post!.total_score).toBeGreaterThanOrEqual(8);
  });

  test("attach stores text files inline (contents populated, is_binary=false, no storage object)", async () => {
    const studentClient = await createAuthenticatedClient(upStudent);
    const { data: sid, error: createErr } = await callRpc(studentClient, upAssignment.id, []);
    expect(createErr).toBeNull();
    const mdSubmissionId = sid!;
    const { error: attachErr } = await (studentClient.rpc as CallableFunction)("attach_no_repo_submission_files", {
      p_submission_id: mdSubmissionId,
      p_files: [
        {
          name: "notes.md",
          is_binary: false,
          contents: "# Title\n\nHello world",
          file_size: 20,
          mime_type: "text/markdown"
        }
      ]
    });
    expect(attachErr).toBeNull();
    const { data: rows } = await supabase
      .from("submission_files")
      .select("name, is_binary, contents, storage_key")
      .eq("submission_id", mdSubmissionId);
    expect(rows).toHaveLength(1);
    expect(rows![0].is_binary).toBe(false);
    expect(rows![0].contents).toContain("# Title");
    expect(rows![0].storage_key).toBeNull();
  });
});

// Instructors/graders can create an upload submission on behalf of a student or
// group (create_submission_for_student), then attach files (attach also
// authorizes graders).
test.describe("Staff create submission on behalf of a student (PR #781)", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  const SPREFIX = getTestRunPrefix();
  const SID = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

  let sClassId: number;
  let sOtherClassId: number;
  let sInstructor: TestingUser;
  let sGrader: TestingUser;
  let sStudent: TestingUser;
  let sOtherStudent: TestingUser;
  let sOutsideInstructor: TestingUser;
  let sAssignment: AssignmentWithRubric;

  test.beforeAll(async () => {
    const cls = await createClass({ name: `E2E Staff Upload ${SPREFIX}` });
    sClassId = cls.id;
    const other = await createClass({ name: `E2E Staff Upload Other ${SPREFIX}` });
    sOtherClassId = other.id;
    sInstructor = await createUserInClass({
      role: "instructor",
      class_id: sClassId,
      name: `SU Instr ${SPREFIX}`,
      email: `e2e-su-instr-${SID}@pawtograder.net`
    });
    sGrader = await createUserInClass({
      role: "grader",
      class_id: sClassId,
      name: `SU Grader ${SPREFIX}`,
      email: `e2e-su-grader-${SID}@pawtograder.net`
    });
    sStudent = await createUserInClass({
      role: "student",
      class_id: sClassId,
      name: `SU Stu ${SPREFIX}`,
      email: `e2e-su-stu-${SID}@pawtograder.net`
    });
    sOtherStudent = await createUserInClass({
      role: "student",
      class_id: sClassId,
      name: `SU Stu2 ${SPREFIX}`,
      email: `e2e-su-stu2-${SID}@pawtograder.net`
    });
    sOutsideInstructor = await createUserInClass({
      role: "instructor",
      class_id: sOtherClassId,
      name: `SU Outsider ${SPREFIX}`,
      email: `e2e-su-out-${SID}@pawtograder.net`
    });
    sAssignment = await insertAssignment({
      class_id: sClassId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `SU Upload ${SPREFIX}`,
      assignment_slug: `e2e-su-${SID}`,
      repo_mode: "none"
    });
  });

  test("instructor creates an upload submission for a student", async () => {
    const ic = await createAuthenticatedClient(sInstructor);
    const { data, error } = await (ic.rpc as CallableFunction)("create_submission_for_student", {
      p_assignment_id: sAssignment.id,
      p_profile_id: sStudent.private_profile_id
    });
    expect(error).toBeNull();
    expect(typeof data).toBe("number");
    const { data: sub } = await supabase
      .from("submissions")
      .select("*")
      .eq("id", data as number)
      .single();
    expect(sub!.submitted_via).toBe("upload");
    expect(sub!.profile_id).toBe(sStudent.private_profile_id);
    expect(sub!.is_active).toBe(true);
    expect(sub!.repository).toBeNull();
  });

  test("grader can create + attach a binary file on behalf of a student (owner can read it)", async () => {
    const gc = await createAuthenticatedClient(sGrader);
    const { data: sid, error: createErr } = await (gc.rpc as CallableFunction)("create_submission_for_student", {
      p_assignment_id: sAssignment.id,
      p_profile_id: sOtherStudent.private_profile_id
    });
    expect(createErr).toBeNull();
    const submissionId = sid as number;
    const key = `classes/${sClassId}/profiles/${sOtherStudent.private_profile_id}/submissions/${submissionId}/files/scan.bin`;
    const bytes = `grader-bytes-${SID}`;
    const { error: upErr } = await gc.storage
      .from("submission-files")
      .upload(key, Buffer.from(bytes), { contentType: "application/octet-stream", upsert: true });
    expect(upErr).toBeNull();
    const { error: attachErr } = await (gc.rpc as CallableFunction)("attach_no_repo_submission_files", {
      p_submission_id: submissionId,
      p_files: [
        {
          name: "scan.bin",
          storage_key: key,
          is_binary: true,
          file_size: bytes.length,
          mime_type: "application/octet-stream"
        }
      ]
    });
    expect(attachErr).toBeNull();

    // The student the submission belongs to can read the bytes.
    const studentClient = await createAuthenticatedClient(sOtherStudent);
    const { data: signed, error: signErr } = await studentClient.storage
      .from("submission-files")
      .createSignedUrl(key, 60);
    expect(signErr).toBeNull();
    const resp = await fetch(signed!.signedUrl);
    expect(resp.ok).toBe(true);
    expect(await resp.text()).toBe(bytes);
  });

  test("a student cannot create a submission on behalf of others", async () => {
    const sc = await createAuthenticatedClient(sStudent);
    const { error } = await (sc.rpc as CallableFunction)("create_submission_for_student", {
      p_assignment_id: sAssignment.id,
      p_profile_id: sOtherStudent.private_profile_id
    });
    expect(error).not.toBeNull();
  });

  test("an instructor from a different class is rejected", async () => {
    const oc = await createAuthenticatedClient(sOutsideInstructor);
    const { error } = await (oc.rpc as CallableFunction)("create_submission_for_student", {
      p_assignment_id: sAssignment.id,
      p_profile_id: sStudent.private_profile_id
    });
    expect(error).not.toBeNull();
  });

  test("wrong repo_mode (no_submission) is rejected", async () => {
    const noSub = await insertAssignment({
      class_id: sClassId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `SU NoSub ${SPREFIX}`,
      repo_mode: "no_submission"
    });
    const ic = await createAuthenticatedClient(sInstructor);
    const { error } = await (ic.rpc as CallableFunction)("create_submission_for_student", {
      p_assignment_id: noSub.id,
      p_profile_id: sStudent.private_profile_id
    });
    expect(error).not.toBeNull();
    expect(error!.message.toLowerCase()).toMatch(/does not accept uploads|repo_mode/);
  });

  test("instructor creates an upload submission for a group", async () => {
    const groupAssignment = await insertAssignment({
      class_id: sClassId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `SU Group ${SPREFIX}`,
      repo_mode: "none",
      group_config: "groups"
    });
    const { data: grp, error: grpErr } = await supabase
      .from("assignment_groups")
      .insert({ name: `SU Grp ${SPREFIX}`, class_id: sClassId, assignment_id: groupAssignment.id })
      .select("id")
      .single();
    expect(grpErr).toBeNull();
    const groupId = grp!.id;
    await supabase.from("assignment_groups_members").insert({
      assignment_group_id: groupId,
      profile_id: sStudent.private_profile_id,
      assignment_id: groupAssignment.id,
      class_id: sClassId,
      added_by: sInstructor.private_profile_id
    });

    const ic = await createAuthenticatedClient(sInstructor);
    const { data, error } = await (ic.rpc as CallableFunction)("create_submission_for_student", {
      p_assignment_id: groupAssignment.id,
      p_assignment_group_id: groupId
    });
    expect(error).toBeNull();
    const { data: sub } = await supabase
      .from("submissions")
      .select("*")
      .eq("id", data as number)
      .single();
    expect(sub!.assignment_group_id).toBe(groupId);
    expect(sub!.submitted_via).toBe("upload");
    expect(sub!.profile_id).toBeNull();
  });
});
