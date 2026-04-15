import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "@/global-setup";
import { subDays } from "date-fns";
import { createClass, createUsersInClass, insertAssignment, TestingUser, supabase } from "@/tests/e2e/TestingUtils";

let course: Course;
let student: TestingUser | undefined;
let assignment: Assignment;

test.beforeEach(async () => {
  course = await createClass({ name: "Auto Apply Late Token Test Class" });

  // Set class-wide token limit
  const { error: classUpdateError } = await supabase
    .from("classes")
    .update({ late_tokens_per_student: 2 })
    .eq("id", course.id);
  if (classUpdateError) {
    throw new Error(`Failed to set late_tokens_per_student: ${classUpdateError.message}`);
  }

  [student] = await createUsersInClass([
    {
      name: "Auto Apply Token Student",
      email: "auto-apply-token-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    }
  ]);

  // Create assignment with due date in the past and auto-apply enabled
  const dueDate = subDays(new Date(), 1);
  assignment = await insertAssignment({
    due_date: dueDate.toUTCString(),
    class_id: course.id,
    name: "Auto Apply Late Token Assignment"
  });

  // Set require_tokens_before_due_date = false to enable auto-apply
  const { error: assignmentUpdateError } = await supabase
    .from("assignments")
    .update({ require_tokens_before_due_date: false, max_late_tokens: 2 })
    .eq("id", assignment.id);
  if (assignmentUpdateError) {
    throw new Error(`Failed to update assignment: ${assignmentUpdateError.message}`);
  }
});

test.describe("Auto-apply late tokens", () => {
  test("When require_tokens_before_due_date is false and student has tokens, submitting late auto-applies a token", async () => {
    const { data: result, error: rpcError } = await supabase.rpc("apply_late_token_extension", {
      p_assignment_id: assignment.id,
      p_student_id: student!.private_profile_id,
      p_assignment_group_id: null as unknown as number,
      p_class_id: course.id,
      p_creator_id: student!.private_profile_id,
      p_hours_late: 25,
      p_tokens_needed: 2
    });

    expect(rpcError).toBeNull();
    expect((result as { success: boolean }).success).toBe(true);

    // Verify the extension row was inserted
    const { data: exceptions, error: exceptionsError } = await supabase
      .from("assignment_due_date_exceptions")
      .select("*")
      .eq("assignment_id", assignment.id)
      .eq("student_id", student!.private_profile_id);

    expect(exceptionsError).toBeNull();
    expect(exceptions).toHaveLength(1);
    expect(exceptions![0].tokens_consumed).toBe(2);
    expect(exceptions![0].hours).toBe(25);
    expect(exceptions![0].note).toBe("Auto-applied on late submission");
  });

  test("When student has no tokens remaining, applying a late token returns success: false", async () => {
    // Exhaust all tokens by inserting an existing exception
    const { error: exhaustError } = await supabase.from("assignment_due_date_exceptions").insert({
      assignment_id: assignment.id,
      student_id: student!.private_profile_id,
      class_id: course.id,
      creator_id: student!.private_profile_id,
      hours: 24,
      minutes: 0,
      tokens_consumed: 2 // uses all 2 class-level tokens
    });
    expect(exhaustError).toBeNull();

    const { data: result, error: rpcError } = await supabase.rpc("apply_late_token_extension", {
      p_assignment_id: assignment.id,
      p_student_id: student!.private_profile_id,
      p_assignment_group_id: null as unknown as number,
      p_class_id: course.id,
      p_creator_id: student!.private_profile_id,
      p_hours_late: 25,
      p_tokens_needed: 1
    });

    expect(rpcError).toBeNull();
    const typedResult = result as { success: boolean; tokens_needed: number; tokens_remaining: number };
    expect(typedResult.success).toBe(false);
    expect(typedResult.tokens_remaining).toBe(0);
  });

  test("Calling the function twice only consumes tokens once (second call sees student is no longer late)", async () => {
    const rpcArgs = {
      p_assignment_id: assignment.id,
      p_student_id: student!.private_profile_id,
      p_assignment_group_id: null as unknown as number,
      p_class_id: course.id,
      p_creator_id: student!.private_profile_id,
      p_hours_late: 25,
      p_tokens_needed: 1
    };

    // First call — student is late, extension is applied
    const { data: result1, error: error1 } = await supabase.rpc("apply_late_token_extension", rpcArgs);
    expect(error1).toBeNull();
    expect((result1 as { success: boolean }).success).toBe(true);

    // Second call — extension from first call now covers the push time, so student is no longer late
    const { data: result2, error: error2 } = await supabase.rpc("apply_late_token_extension", rpcArgs);
    expect(error2).toBeNull();
    expect((result2 as { success: boolean }).success).toBe(true);

    // Only one extension row should exist
    const { data: exceptions } = await supabase
      .from("assignment_due_date_exceptions")
      .select("*")
      .eq("assignment_id", assignment.id)
      .eq("student_id", student!.private_profile_id);

    expect(exceptions).toHaveLength(1);
    expect(exceptions![0].tokens_consumed).toBe(1);
  });
});
