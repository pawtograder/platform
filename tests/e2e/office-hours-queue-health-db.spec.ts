import { expect, test } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  insertHelpQueueAssignment,
  insertHelpRequest,
  insertOfficeHoursQueue,
  supabase
} from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";

type QueueHealthRow = {
  queue_id: number;
  queue_name: string;
  waiting: number;
  oldest_wait_seconds: number;
  helping: number;
  staffed_tas: number;
  unstaffed_seconds: number | null;
  resolved_today: number;
  median_wait_seconds_today: number;
};

/**
 * Contract tests for office_hours_queue_health
 * (supabase/migrations/20261117174200_office_hours_queue_health.sql).
 *
 * Two things the UI cannot check for itself:
 *   * the RPC must skip inactive queues, because the staff dashboard only renders active ones and
 *     the red-queue alert loops over whatever the RPC returns. Without the filter, an inactive
 *     queue holding a stale open request alerts about a card nobody can see;
 *   * "staffed" means a shift row with no ended_at, not one flagged is_active. The Unstaffed badge
 *     and the card's tone both read staffed_tas, so the two definitions have to stay apart.
 */
test.describe("office hours queue health RPC", () => {
  test.describe.configure({ timeout: 120_000 });

  let classId: number;
  let activeQueueId: number;
  let inactiveQueueId: number;
  let instructor: TestingUser;
  let ta: TestingUser;
  let student: TestingUser;
  let instructorClient: SupabaseClient<Database>;
  let studentClient: SupabaseClient<Database>;

  /** The RPC is not in the generated types yet, so the call is typed here. */
  async function queueHealth(
    client: SupabaseClient<Database>
  ): Promise<{ data: QueueHealthRow[] | null; error: { message: string; code?: string } | null }> {
    return await (
      client as unknown as {
        rpc: (
          fn: string,
          args: object
        ) => Promise<{ data: QueueHealthRow[] | null; error: { message: string; code?: string } | null }>;
      }
    ).rpc("office_hours_queue_health", { p_class_id: classId });
  }

  async function healthFor(queueId: number): Promise<QueueHealthRow | undefined> {
    const { data, error } = await queueHealth(instructorClient);
    expect(error).toBeNull();
    return (data ?? []).find((row) => row.queue_id === queueId);
  }

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const course = await createClass({ name: `E2E Queue Health ${suffix}` });
    classId = course.id;

    instructor = await createUserInClass({
      role: "instructor",
      class_id: classId,
      name: `E2E Queue Health Instructor ${suffix}`,
      email: `e2e-queue-health-instructor-${suffix}@pawtograder.net`
    });
    ta = await createUserInClass({
      role: "grader",
      class_id: classId,
      name: `E2E Queue Health TA ${suffix}`,
      email: `e2e-queue-health-ta-${suffix}@pawtograder.net`
    });
    student = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `E2E Queue Health Student ${suffix}`,
      email: `e2e-queue-health-student-${suffix}@pawtograder.net`
    });

    instructorClient = await createAuthenticatedClient(instructor);
    studentClient = await createAuthenticatedClient(student);

    activeQueueId = (await insertOfficeHoursQueue({ class_id: classId, name: `Active ${suffix}` })).id;
    inactiveQueueId = (await insertOfficeHoursQueue({ class_id: classId, name: `Inactive ${suffix}` })).id;

    const { error: deactivateError } = await supabase
      .from("help_queues")
      .update({ is_active: false })
      .eq("id", inactiveQueueId);
    expect(deactivateError).toBeNull();

    // One student waiting on each queue, so the only difference between them is is_active.
    for (const help_queue_id of [activeQueueId, inactiveQueueId]) {
      await insertHelpRequest({
        class_id: classId,
        student_profile_id: student.private_profile_id,
        request: "Queue health fixture",
        help_queue_id,
        status: "open"
      });
    }
  });

  test("an active queue is reported with its waiting count", async () => {
    const health = await healthFor(activeQueueId);
    expect(health).toBeDefined();
    expect(health!.waiting).toBe(1);
    expect(health!.oldest_wait_seconds).toBeGreaterThanOrEqual(0);
  });

  test("an inactive queue is left out, even with a student waiting on it", async () => {
    // The request on the inactive queue is identical to the one on the active queue, so a missing
    // is_active filter would return this row and the red-queue alert would fire for a hidden card.
    const { data: waiting, error } = await supabase
      .from("help_requests")
      .select("id")
      .eq("help_queue", inactiveQueueId)
      .eq("status", "open");
    expect(error).toBeNull();
    expect(waiting!.length).toBeGreaterThan(0);

    expect(await healthFor(inactiveQueueId)).toBeUndefined();
  });

  test("a shift with no ended_at counts as staffed even when it is flagged inactive", async () => {
    await insertHelpQueueAssignment({
      class_id: classId,
      help_queue_id: activeQueueId,
      ta_profile_id: ta.private_profile_id
    });
    const { error } = await supabase
      .from("help_queue_assignments")
      .update({ is_active: false })
      .eq("class_id", classId)
      .eq("help_queue_id", activeQueueId)
      .eq("ta_profile_id", ta.private_profile_id)
      .is("ended_at", null);
    expect(error).toBeNull();

    // The badge and the card tone both key off staffed_tas, so this is the number that decides
    // whether the instructor sees "Unstaffed" on a queue that does have someone on shift.
    const health = await healthFor(activeQueueId);
    expect(health!.staffed_tas).toBe(1);
    expect(health!.unstaffed_seconds).toBeNull();
  });

  test("a student cannot read queue health", async () => {
    const { error } = await queueHealth(studentClient);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
  });
  // ---- metrics_office_hours_queue_health (20261119130000) -------------------------------------
  // The metric drives pawtograder_office_hours_queues_red, and docs/metrics.md promises it cannot
  // disagree with the dashboard RPC above. These pin the two places it did.

  type MetricRow = {
    class_id: number;
    queues_active: number;
    queues_red: number;
    queues_unstaffed: number;
    requests_waiting: number;
    oldest_wait_minutes: number;
  };

  /**
   * The RPC is not on the generated `Database` yet, the same reason the metrics edge function
   * calls it through `rpcUntyped` (supabase/functions/metrics/index.ts:99).
   */
  function callMetric(client: SupabaseClient<Database>) {
    const untyped = client as unknown as {
      rpc: (name: string) => Promise<{ data: MetricRow[] | null; error: { code?: string } | null }>;
    };
    return untyped.rpc("metrics_office_hours_queue_health");
  }

  async function metricFor(cid: number): Promise<MetricRow | undefined> {
    const { data, error } = await callMetric(supabase);
    expect(error).toBeNull();
    return data!.find((r) => r.class_id === cid);
  }

  async function setThresholds(value: unknown) {
    const { error } = await supabase
      .from("classes")
      .update({ office_hours_health_thresholds: value as never })
      .eq("id", classId);
    expect(error).toBeNull();
  }

  async function ageOldestOpenRequest(seconds: number) {
    const { data, error } = await supabase
      .from("help_requests")
      .select("id")
      .eq("help_queue", activeQueueId)
      .eq("status", "open")
      .order("created_at", { ascending: true })
      .limit(1);
    expect(error).toBeNull();
    const { error: updateError } = await supabase
      .from("help_requests")
      .update({ created_at: new Date(Date.now() - seconds * 1000).toISOString() })
      .eq("id", data![0].id);
    expect(updateError).toBeNull();
  }

  test("a wait just under the limit is not red, in the metric or the dashboard", async () => {
    // 29m40s. Comparing rounded minutes made this 30 and counted it red, while the dashboard,
    // which needs oldest_wait_seconds >= 1800, did not.
    await setThresholds({ waiting_red: 5, oldest_wait_red_minutes: 30 });
    await ageOldestOpenRequest(29 * 60 + 40);

    const metric = await metricFor(classId);
    const health = await healthFor(activeQueueId);
    expect(health!.oldest_wait_seconds).toBeLessThan(30 * 60);
    expect(metric!.queues_red).toBe(0);
    expect(metric!.oldest_wait_minutes).toBe(29);
  });

  test("a wait just over the limit is red", async () => {
    await setThresholds({ waiting_red: 5, oldest_wait_red_minutes: 30 });
    await ageOldestOpenRequest(30 * 60 + 10);

    const metric = await metricFor(classId);
    expect(metric!.queues_red).toBe(1);
    expect(metric!.oldest_wait_minutes).toBe(30);
  });

  test("a fractional threshold does not drop every class's row", async () => {
    // Queue Settings posts with noValidate and no step check, and the column has no constraint,
    // so 2.5 is reachable. Casting with ::int raised, and because the function reads every class
    // in one statement that removed all five gauges for every class.
    await setThresholds({ waiting_red: 2.5, oldest_wait_red_minutes: 30 });
    const { data, error } = await callMetric(supabase);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    expect(data!.some((r) => r.class_id === classId)).toBe(true);
  });

  test("a non-positive or non-numeric threshold falls back to the default", async () => {
    // parseQueueHealthThresholds takes only positive finite numbers; the function used to take 0
    // as stored and mark every queue red.
    await ageOldestOpenRequest(60);
    for (const stored of [{ waiting_red: 0, oldest_wait_red_minutes: 60 }, { waiting_red: "lots" }]) {
      await setThresholds(stored);
      const metric = await metricFor(classId);
      expect(metric).toBeDefined();
      expect(metric!.queues_red).toBe(0);
    }
  });

  test("anon and authenticated cannot execute the metric", async () => {
    const { error } = await callMetric(studentClient);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
  });
});
