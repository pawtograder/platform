import { expect, test } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  insertHelpRequest,
  supabase
} from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";

// Contract tests for office hours escalation
// (supabase/migrations/20261029120000_help_request_escalation.sql). No browser: these pin the
// guardrails the UI relies on, because the UI only hides buttons and a student can call PostgREST
// directly.
//   * only the staff member currently helping can escalate, and only while in_progress;
//   * staff Resolve opens a check-in window; End ticket closes for good;
//   * a student can escalate only from that window, with a note;
//   * students cannot write escalation fields, reopen a ticket, or read staff notes.
test.describe("help request escalation RPCs", () => {
  test.describe.configure({ timeout: 180_000 });

  let classId: number;
  let ta: TestingUser;
  let otherTa: TestingUser;
  let student: TestingUser;
  let outsider: TestingUser;
  let taClient: SupabaseClient<Database>;
  let otherTaClient: SupabaseClient<Database>;
  let studentClient: SupabaseClient<Database>;
  let outsiderClient: SupabaseClient<Database>;

  async function freshRequest(status: "open" | "in_progress" = "in_progress"): Promise<number> {
    const { id } = await insertHelpRequest({
      class_id: classId,
      student_profile_id: student.private_profile_id,
      request: `Escalation contract ${Date.now()}`
    });
    if (status === "in_progress") {
      const { error } = await supabase
        .from("help_requests")
        .update({ status: "in_progress", assignee: ta.private_profile_id })
        .eq("id", id);
      expect(error).toBeNull();
    }
    return id;
  }

  async function row(id: number) {
    const { data, error } = await supabase.from("help_requests").select("*").eq("id", id).single();
    expect(error).toBeNull();
    return data!;
  }

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const course = await createClass({ name: `E2E Escalation ${suffix}` });
    classId = course.id;
    ta = await createUserInClass({
      role: "grader",
      class_id: classId,
      name: `E2E Escalation TA ${suffix}`,
      email: `e2e-escalation-ta-${suffix}@pawtograder.net`
    });
    otherTa = await createUserInClass({
      role: "grader",
      class_id: classId,
      name: `E2E Escalation TA2 ${suffix}`,
      email: `e2e-escalation-ta2-${suffix}@pawtograder.net`
    });
    student = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `E2E Escalation Student ${suffix}`,
      email: `e2e-escalation-student-${suffix}@pawtograder.net`
    });
    outsider = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `E2E Escalation Outsider ${suffix}`,
      email: `e2e-escalation-outsider-${suffix}@pawtograder.net`
    });
    [taClient, otherTaClient, studentClient, outsiderClient] = await Promise.all(
      [ta, otherTa, student, outsider].map((u) => createAuthenticatedClient(u))
    );
  });

  test("assigned TA escalates: ticket reopens flagged and the note is recorded", async () => {
    const id = await freshRequest();
    const { error } = await taClient.rpc("escalate_help_request", {
      p_help_request_id: id,
      p_note: "  Successor's right child is dropped  "
    });
    expect(error).toBeNull();

    const r = await row(id);
    expect(r.status).toBe("open");
    expect(r.assignee).toBeNull();
    expect(r.escalation_count).toBe(1);

    const { data: notes } = await otherTaClient.from("help_request_escalations").select("*").eq("help_request_id", id);
    expect(notes).toHaveLength(1);
    expect(notes![0]).toMatchObject({ source: "staff", note: "Successor's right child is dropped" });
    expect(notes![0].previous_assignee).toBe(ta.private_profile_id);
  });

  test("escalation is refused for a waiting ticket, another TA, a student, or an empty note", async () => {
    const waiting = await freshRequest("open");
    expect(
      (await taClient.rpc("escalate_help_request", { p_help_request_id: waiting, p_note: "x" })).error
    ).not.toBeNull();

    const active = await freshRequest();
    expect(
      (await otherTaClient.rpc("escalate_help_request", { p_help_request_id: active, p_note: "x" })).error
    ).not.toBeNull();
    expect(
      (await studentClient.rpc("escalate_help_request", { p_help_request_id: active, p_note: "x" })).error
    ).not.toBeNull();
    expect(
      (await taClient.rpc("escalate_help_request", { p_help_request_id: active, p_note: "   " })).error
    ).not.toBeNull();
    expect((await row(active)).escalation_count).toBe(0);
  });

  test("Resolve opens a check-in; 'not fixed' escalates with the student's note", async () => {
    const id = await freshRequest();
    expect(
      (await taClient.rpc("finish_help_request", { p_help_request_id: id, p_end_ticket: false })).error
    ).toBeNull();
    const resolved = await row(id);
    expect(resolved.status).toBe("resolved");
    expect(new Date(resolved.check_in_expires_at!).getTime()).toBeGreaterThan(Date.now());

    // Not on the ticket, and no note: both refused.
    expect(
      (await outsiderClient.rpc("answer_help_request_check_in", { p_help_request_id: id, p_fixed: false, p_note: "n" }))
        .error
    ).not.toBeNull();
    expect(
      (await studentClient.rpc("answer_help_request_check_in", { p_help_request_id: id, p_fixed: false, p_note: "" }))
        .error
    ).not.toBeNull();

    const { error } = await studentClient.rpc("answer_help_request_check_in", {
      p_help_request_id: id,
      p_fixed: false,
      p_note: "Still lost on the recursion"
    });
    expect(error).toBeNull();
    const reopened = await row(id);
    expect(reopened).toMatchObject({ status: "open", assignee: null, escalation_count: 1, resolved_at: null });
    expect(reopened.check_in_expires_at).toBeNull();

    // A second answer in the same window is refused: the check-in is used up.
    expect(
      (await studentClient.rpc("answer_help_request_check_in", { p_help_request_id: id, p_fixed: true })).error
    ).not.toBeNull();
  });

  test("resolving a ticket nobody picked up opens no check-in", async () => {
    const id = await freshRequest("open");
    expect(
      (await taClient.rpc("finish_help_request", { p_help_request_id: id, p_end_ticket: false })).error
    ).toBeNull();
    const r = await row(id);
    expect(r.status).toBe("resolved");
    expect(r.check_in_expires_at).toBeNull();
    expect(
      (await studentClient.rpc("answer_help_request_check_in", { p_help_request_id: id, p_fixed: false, p_note: "n" }))
        .error
    ).not.toBeNull();
  });

  test("'fixed' clears the check-in and leaves the ticket resolved", async () => {
    const id = await freshRequest();
    await taClient.rpc("finish_help_request", { p_help_request_id: id, p_end_ticket: false });
    expect(
      (await studentClient.rpc("answer_help_request_check_in", { p_help_request_id: id, p_fixed: true })).error
    ).toBeNull();
    const r = await row(id);
    expect(r.status).toBe("resolved");
    expect(r.check_in_expires_at).toBeNull();
  });

  test("End ticket is final: no check-in, no escalation, no reopening", async () => {
    const id = await freshRequest();
    expect((await taClient.rpc("finish_help_request", { p_help_request_id: id, p_end_ticket: true })).error).toBeNull();
    const r = await row(id);
    expect(r.status).toBe("closed");
    expect(r.check_in_expires_at).toBeNull();

    expect(
      (await studentClient.rpc("answer_help_request_check_in", { p_help_request_id: id, p_fixed: false, p_note: "n" }))
        .error
    ).not.toBeNull();
    await studentClient.from("help_requests").update({ status: "open" }).eq("id", id);
    expect((await row(id)).status).toBe("closed");

    // Staff can't undo it with a direct update either.
    const staffReopen = await taClient.from("help_requests").update({ status: "open" }).eq("id", id);
    expect(staffReopen.error).not.toBeNull();
    expect((await row(id)).status).toBe("closed");
  });

  test("End ticket withdraws a pending check-in", async () => {
    const id = await freshRequest();
    await taClient.rpc("finish_help_request", { p_help_request_id: id, p_end_ticket: false });
    expect((await taClient.rpc("finish_help_request", { p_help_request_id: id, p_end_ticket: true })).error).toBeNull();
    expect((await row(id)).status).toBe("closed");
    expect(
      (await studentClient.rpc("answer_help_request_check_in", { p_help_request_id: id, p_fixed: false, p_note: "n" }))
        .error
    ).not.toBeNull();
  });

  test("an expired check-in is refused", async () => {
    const id = await freshRequest();
    await taClient.rpc("finish_help_request", { p_help_request_id: id, p_end_ticket: false });
    await supabase
      .from("help_requests")
      .update({ check_in_expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", id);
    expect(
      (await studentClient.rpc("answer_help_request_check_in", { p_help_request_id: id, p_fixed: false, p_note: "n" }))
        .error
    ).not.toBeNull();
  });

  test("students cannot write escalation fields, reopen tickets, or read notes", async () => {
    const id = await freshRequest();
    await taClient.rpc("escalate_help_request", { p_help_request_id: id, p_note: "Staff-only context" });

    const reset = await studentClient.from("help_requests").update({ escalation_count: 0 }).eq("id", id);
    expect(reset.error).not.toBeNull();
    const window = await studentClient
      .from("help_requests")
      .update({ check_in_expires_at: new Date(Date.now() + 3_600_000).toISOString() })
      .eq("id", id);
    expect(window.error).not.toBeNull();
    expect((await row(id)).escalation_count).toBe(1);

    const { data: visibleNotes } = await studentClient
      .from("help_request_escalations")
      .select("*")
      .eq("help_request_id", id);
    expect(visibleNotes).toEqual([]);

    const insert = await studentClient.from("help_request_escalations").insert({
      class_id: classId,
      help_request_id: id,
      escalated_by: student.private_profile_id,
      source: "student",
      note: "forged"
    });
    expect(insert.error).not.toBeNull();
  });

  test("a student can still resolve their own open ticket", async () => {
    const id = await freshRequest("open");
    const { error } = await studentClient
      .from("help_requests")
      .update({ status: "resolved", resolved_by: student.private_profile_id, resolved_at: new Date().toISOString() })
      .eq("id", id);
    expect(error).toBeNull();
    const r = await row(id);
    expect(r.status).toBe("resolved");
    expect(r.check_in_expires_at).toBeNull();
  });
});
