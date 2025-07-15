import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { TZDate } from "@date-fns/tz";
import { expect, test } from "@playwright/test";
import { addDays, addHours, addMinutes, previousMonday } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import {
  createLabSectionWithStudents,
  createUserInDemoClass,
  insertAssignment,
  insertSubmissionViaAPI,
  loginAsUser,
  supabase,
  TestingUser,
  updateClassSettings,
} from "./TestingUtils";
let student: TestingUser | undefined;

let assignmentInFuture: Assignment | undefined;
let assignmentInPast: Assignment | undefined;
let assignmentExtended: Assignment | undefined;

test.beforeAll(async () => {
  await updateClassSettings({
    class_id: 1,
    start_date: addDays(new Date(), -30).toUTCString(),
    end_date: addDays(new Date(), 90).toUTCString(),
    late_tokens_per_student: 10
  });
  student = await createUserInDemoClass({ role: "student" });
  assignmentInFuture = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString()
  });
  assignmentInPast = await insertAssignment({
    due_date: addMinutes(new Date(), -5).toUTCString()
  });
  assignmentExtended = await insertAssignment({
    due_date: addMinutes(new Date(), -5).toUTCString()
  });
  await supabase.from("assignment_due_date_exceptions").insert({
    assignment_id: assignmentExtended.id,
    class_id: 1,
    creator_id: student.private_profile_id,
    student_id: student.private_profile_id,
    hours: 24,
    minutes: 0,
    tokens_consumed: 1,
    note: "Test note"
  });
});
test.describe("Create submission", () => {

    test("If the deadline is in the future, the student can create a submission", async ({ page }) => {
        const submission = await insertSubmissionViaAPI({
            student_profile_id: student!.private_profile_id,
            assignment_id: assignmentInFuture!.id
        });
        expect(submission).toBeDefined();
        await loginAsUser(page, student!);
        await expect(page.getByRole("link").filter({ hasText: "Assignments" })).toBeVisible();
        const submissionPage = `/course/1/assignments/${assignmentInFuture!.id}/submissions/${submission.submission_id}`;
        await page.goto(submissionPage);
        await page.getByRole("button", { name: "Files" }).click();
        await expect(page.getByText("package com.pawtograder.example.java")).toBeVisible();
    });
    test("If the deadline has passed, the student cannot create a submission", async () => {
        const submission = insertSubmissionViaAPI({
            student_profile_id: student!.private_profile_id,
            assignment_id: assignmentInPast!.id
        });
        await expect(submission).rejects.toThrow("You cannot submit after the due date");
    });
    test("If the student has extended their due date, they can create a submission", async ({ page }) => {
        const submission = await insertSubmissionViaAPI({
            student_profile_id: student!.private_profile_id,
            assignment_id: assignmentExtended!.id
        });
        expect(submission).toBeDefined();
        await loginAsUser(page, student!);
        await expect(page.getByRole("link").filter({ hasText: "Assignments" })).toBeVisible();
        const submissionPage = `/course/1/assignments/${assignmentInFuture!.id}/submissions/${submission.submission_id}`;
        await page.goto(submissionPage);
        await page.getByRole("button", { name: "Files" }).click();
        await expect(page.getByText("package com.pawtograder.example.java")).toBeVisible();
    });
});