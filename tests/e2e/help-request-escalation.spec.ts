import type { Browser, Page } from "@playwright/test";
import { Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import dotenv from "dotenv";
import {
  createClass,
  createUsersInClass,
  insertHelpQueueAssignment,
  insertHelpRequest,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";
dotenv.config({ path: ".env.local", quiet: true });

// End-to-end flow for office hours escalation (docs/prd-oh-escalation.md):
// TA resolves -> student says it wasn't fixed -> another TA sees the ticket flagged at the top of
// the queue with the note, and claims it. Then: End ticket closes for good with no check-in.
// The RPC guardrails themselves are covered in help-request-escalation-db.spec.ts.

let course: Course;
let taA: TestingUser;
let taB: TestingUser;
let student: TestingUser;
let otherStudent: TestingUser;
let queueId: number;

const STUDENT_NOTE = "I fixed the successor lookup but the right child still gets dropped.";

async function newSession(browser: Browser, user: TestingUser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAsUser(page, user, course);
  return page;
}

async function startHelping(requestId: number, ta: TestingUser) {
  const { error } = await supabase
    .from("help_requests")
    .update({ status: "in_progress", assignee: ta.private_profile_id })
    .eq("id", requestId);
  expect(error).toBeNull();
}

test.describe("office hours escalation", () => {
  test.describe.configure({ mode: "serial", timeout: 240_000 });

  test.beforeAll(async () => {
    course = await createClass();
    [taA, taB, student, otherStudent] = await createUsersInClass([
      {
        name: "Escalation TA Priya",
        email: "escalation-ta-a@pawtograder.net",
        role: "grader",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Escalation TA Marcus",
        email: "escalation-ta-b@pawtograder.net",
        role: "grader",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Escalation Student Jordan",
        email: "escalation-student@pawtograder.net",
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Escalation Student Sam",
        email: "escalation-student-2@pawtograder.net",
        role: "student",
        class_id: course.id,
        useMagicLink: true
      }
    ]);

    const { data: queue } = await supabase
      .from("help_queues")
      .select("id")
      .eq("class_id", course.id)
      .eq("name", "office-hours")
      .single();
    queueId = queue!.id;
    await insertHelpQueueAssignment({
      class_id: course.id,
      help_queue_id: queueId,
      ta_profile_id: taA.private_profile_id
    });
    await insertHelpQueueAssignment({
      class_id: course.id,
      help_queue_id: queueId,
      ta_profile_id: taB.private_profile_id
    });
  });

  test("student escalates from the check-in and another TA claims it first", async ({ browser }) => {
    // An older normal ticket, so the escalated one has to jump ahead of it.
    const older = await insertHelpRequest({
      class_id: course.id,
      student_profile_id: otherStudent.private_profile_id,
      request: "Gradle can't find JUnit 5 from the terminal"
    });
    const escalating = await insertHelpRequest({
      class_id: course.id,
      student_profile_id: student.private_profile_id,
      request: "My BST delete fails testDeleteRootWithTwoChildren"
    });
    await startHelping(escalating.id, taA);

    const taPage = await newSession(browser, taA);
    await taPage.goto(`/course/${course.id}/manage/office-hours/request/${escalating.id}`);
    await taPage.getByRole("button", { name: "Resolve" }).click();
    await taPage.getByRole("button", { name: "Confirm action" }).click();
    await expect(taPage.getByText("The student will be asked whether their problem got fixed.")).toBeVisible();

    const studentPage = await newSession(browser, student);
    const checkIn = studentPage.getByRole("dialog", { name: "Did your problem get fixed?" });
    await expect(checkIn).toBeVisible({ timeout: 30_000 });
    await checkIn.getByRole("button", { name: /No, still stuck/ }).click();
    await checkIn.getByRole("button", { name: "Escalate my request" }).click();
    await expect(checkIn.getByText("Add a short note on what is still unresolved.")).toBeVisible();
    await checkIn.getByRole("textbox").fill(STUDENT_NOTE);
    await checkIn.getByRole("button", { name: "Escalate my request" }).click();
    await expect(checkIn).toBeHidden();

    const taBPage = await newSession(browser, taB);
    await taBPage.goto(`/course/${course.id}/manage/office-hours`);
    const rows = taBPage.locator(`a[href*="/manage/office-hours/request/"]`);
    await expect(rows.first()).toHaveAttribute("href", new RegExp(`/request/${escalating.id}$`), { timeout: 30_000 });
    await expect(rows.first()).toContainText("Escalated");
    await expect(rows.first()).toContainText(`Still unresolved: ${STUDENT_NOTE}`);
    await expect(rows.nth(1)).toHaveAttribute("href", new RegExp(`/request/${older.id}$`));

    await rows.first().click();
    const history = taBPage.getByRole("region", { name: "Escalation history" });
    await expect(history).toContainText(STUDENT_NOTE);
    await expect(history).toContainText("Escalation TA Priya");
    await taBPage.getByRole("button", { name: "Start Helping" }).click();
    await expect(taBPage.getByText("You're now helping!")).toBeVisible();
    await expect(taBPage.getByRole("button", { name: "Escalate", exact: true })).toBeVisible();

    await expect
      .poll(async () => {
        const { data } = await supabase
          .from("help_requests")
          .select("status, assignee, escalation_count")
          .eq("id", escalating.id)
          .single();
        return data;
      })
      .toEqual({ status: "in_progress", assignee: taB.private_profile_id, escalation_count: 1 });
  });

  test("End ticket after Resolve withdraws the check-in and closes for good", async ({ browser }) => {
    const ended = await insertHelpRequest({
      class_id: course.id,
      student_profile_id: student.private_profile_id,
      request: "Is it OK to use ArrayDeque for Project 2?"
    });
    await startHelping(ended.id, taA);

    const taPage = await newSession(browser, taA);
    await taPage.goto(`/course/${course.id}/manage/office-hours/request/${ended.id}`);
    // Resolve first: End ticket must stay available while the student's check-in is pending,
    // so staff can withdraw it.
    await taPage.getByRole("button", { name: "Resolve" }).click();
    await taPage.getByRole("button", { name: "Confirm action" }).click();
    await expect(taPage.getByText("The student will be asked whether their problem got fixed.")).toBeVisible();
    await taPage.getByRole("button", { name: "End ticket" }).click();
    await taPage.getByRole("button", { name: "Confirm action" }).click();
    await expect(taPage.getByText("This ticket is closed and can't be escalated again.")).toBeVisible();

    const { data: row } = await supabase.from("help_requests").select("*").eq("id", ended.id).single();
    expect(row).toMatchObject({ status: "closed", check_in_expires_at: null });

    const studentPage = await newSession(browser, student);
    await studentPage.goto(`/course/${course.id}/office-hours/request/${ended.id}`);
    await expect(studentPage.getByText("Course staff ended this help request.")).toBeVisible({ timeout: 30_000 });
    await expect(studentPage.getByRole("dialog", { name: "Did your problem get fixed?" })).toHaveCount(0);
  });
});
