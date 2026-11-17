import { expect, test } from "@playwright/test";
import {
  createClass,
  createUserInClass,
  insertHelpQueueAssignment,
  insertHelpRequest,
  insertOfficeHoursQueue,
  setCourseFeature,
  supabase
} from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";

/**
 * The shift-end release trigger from 20261117174000_office_hours_release_on_shift_end.sql.
 *
 * Its scoping is the part worth pinning down. It releases only the ending TA's in_progress
 * requests; on the queue whose shift ended always, and on other queues only once that TA has no
 * shift still running. Dropping any one of those conditions still passes a test that checks one
 * request in isolation, so each case below has a request that must NOT move.
 */
test.describe("office hours shift-end release", () => {
  test.describe.configure({ timeout: 120_000 });

  let classId: number;
  let queueId: number;
  let otherQueueId: number;
  let ta: TestingUser;
  let otherTa: TestingUser;
  let soloTa: TestingUser;
  let student: TestingUser;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const course = await createClass({ name: `E2E Shift Release ${suffix}` });
    classId = course.id;

    ta = await createUserInClass({
      role: "grader",
      class_id: classId,
      name: `E2E Shift Release TA ${suffix}`,
      email: `e2e-shift-release-ta-${suffix}@pawtograder.net`
    });
    otherTa = await createUserInClass({
      role: "grader",
      class_id: classId,
      name: `E2E Shift Release Other TA ${suffix}`,
      email: `e2e-shift-release-other-ta-${suffix}@pawtograder.net`
    });
    // Kept clear of the other cases, so this TA's only shift is the one its own test ends.
    soloTa = await createUserInClass({
      role: "grader",
      class_id: classId,
      name: `E2E Shift Release Solo TA ${suffix}`,
      email: `e2e-shift-release-solo-ta-${suffix}@pawtograder.net`
    });
    student = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `E2E Shift Release Student ${suffix}`,
      email: `e2e-shift-release-student-${suffix}@pawtograder.net`
    });

    queueId = (await insertOfficeHoursQueue({ class_id: classId, name: `Shift release ${suffix}` })).id;
    otherQueueId = (await insertOfficeHoursQueue({ class_id: classId, name: `Other queue ${suffix}` })).id;
  });

  /** A request already picked up by `assignee` on `help_queue_id`. */
  async function inProgressRequest(help_queue_id: number, assignee: string): Promise<number> {
    const { id } = await insertHelpRequest({
      class_id: classId,
      student_profile_id: student.private_profile_id,
      request: "Shift release fixture",
      help_queue_id,
      status: "in_progress"
    });
    const { error } = await supabase.from("help_requests").update({ assignee }).eq("id", id);
    if (error) {
      throw new Error(`Failed to assign help request ${id}: ${error.message}`);
    }
    return id;
  }

  /** Starts a shift, then ends it, which is what fires the trigger. */
  async function endShift(help_queue_id: number, ta_profile_id: string): Promise<void> {
    await insertHelpQueueAssignment({ class_id: classId, help_queue_id, ta_profile_id });
    const { error } = await supabase
      .from("help_queue_assignments")
      .update({ ended_at: new Date().toISOString(), is_active: false })
      .eq("class_id", classId)
      .eq("help_queue_id", help_queue_id)
      .eq("ta_profile_id", ta_profile_id)
      .is("ended_at", null);
    if (error) {
      throw new Error(`Failed to end shift on queue ${help_queue_id}: ${error.message}`);
    }
  }

  async function readRequest(id: number): Promise<{ status: string; assignee: string | null }> {
    const { data, error } = await supabase.from("help_requests").select("status, assignee").eq("id", id).single();
    if (error || !data) {
      throw new Error(`Failed to read help request ${id}: ${error?.message ?? "no row"}`);
    }
    return data;
  }

  test("with the feature off, ending a shift leaves the TA's request in progress", async () => {
    await setCourseFeature(classId, "office-hours-shift-release", false);
    const requestId = await inProgressRequest(queueId, ta.private_profile_id);

    await endShift(queueId, ta.private_profile_id);

    const request = await readRequest(requestId);
    expect(request.status).toBe("in_progress");
    expect(request.assignee).toBe(ta.private_profile_id);
  });

  test("with the feature on, only the ending TA's requests on that queue are released", async () => {
    await setCourseFeature(classId, "office-hours-shift-release", true);

    const released = await inProgressRequest(queueId, ta.private_profile_id);
    // Same queue, a different TA. Dropping the assignee filter would release this one too.
    const otherTaRequest = await inProgressRequest(queueId, otherTa.private_profile_id);
    // Same TA, a different queue, and the TA keeps a shift there. Releasing other queues without
    // checking for a shift still running would release this one too.
    const otherQueueRequest = await inProgressRequest(otherQueueId, ta.private_profile_id);
    // The other TA is on duty on both queues, so neither shift ends when this one does.
    await insertHelpQueueAssignment({
      class_id: classId,
      help_queue_id: queueId,
      ta_profile_id: otherTa.private_profile_id
    });
    await insertHelpQueueAssignment({
      class_id: classId,
      help_queue_id: otherQueueId,
      ta_profile_id: ta.private_profile_id
    });

    await endShift(queueId, ta.private_profile_id);

    const releasedRequest = await readRequest(released);
    expect(releasedRequest.status).toBe("open");
    expect(releasedRequest.assignee).toBeNull();

    const untouchedOtherTa = await readRequest(otherTaRequest);
    expect(untouchedOtherTa.status).toBe("in_progress");
    expect(untouchedOtherTa.assignee).toBe(otherTa.private_profile_id);

    const untouchedOtherQueue = await readRequest(otherQueueRequest);
    expect(untouchedOtherQueue.status).toBe("in_progress");
    expect(untouchedOtherQueue.assignee).toBe(ta.private_profile_id);
  });

  test("with the feature on, the TA's last shift ending releases their requests on other queues", async () => {
    await setCourseFeature(classId, "office-hours-shift-release", true);

    // Nothing requires a TA to be on shift in a queue to help in it, so this is the stranded
    // request the feature exists to prevent: the TA goes off duty holding it.
    const strandedElsewhere = await inProgressRequest(otherQueueId, soloTa.private_profile_id);
    // Same queue, a different TA who is still on shift. Dropping the assignee filter would
    // release this one too.
    const otherTaRequest = await inProgressRequest(otherQueueId, otherTa.private_profile_id);

    await endShift(queueId, soloTa.private_profile_id);

    const released = await readRequest(strandedElsewhere);
    expect(released.status).toBe("open");
    expect(released.assignee).toBeNull();

    const untouched = await readRequest(otherTaRequest);
    expect(untouched.status).toBe("in_progress");
    expect(untouched.assignee).toBe(otherTa.private_profile_id);
  });

  test("with the feature on, a request nobody picked up is left alone", async () => {
    await setCourseFeature(classId, "office-hours-shift-release", true);
    const { id: waiting } = await insertHelpRequest({
      class_id: classId,
      student_profile_id: student.private_profile_id,
      request: "Still waiting",
      help_queue_id: queueId,
      status: "open"
    });

    await endShift(queueId, ta.private_profile_id);

    const request = await readRequest(waiting);
    expect(request.status).toBe("open");
    expect(request.assignee).toBeNull();
  });
});
