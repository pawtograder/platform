import dotenv from "dotenv";
import {
  createAssignmentsAndGradebookColumns,
  createClass,
  createUsersInClass,
  insertPreBakedSubmission,
  supabase,
  TestingUser
} from "../e2e/TestingUtils";
import { expect } from "../global-setup";
// removed unused import

dotenv.config({ path: ".env.local" });

async function test() {
  let students: TestingUser[] = [];
  let instructor: TestingUser | undefined;
  // Create the class
  const course = await createClass({
    name: "Gradebook Test Course"
  });

  // Create a small roster and an instructor
  const users = await createUsersInClass([
    {
      name: "Alice Anderson",
      email: "alice-gradebook@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Bob Brown",
      email: "bob-gradebook@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Charlie Chen",
      email: "charlie-gradebook@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Professor Smith",
      email: "prof-smith-gradebook@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);

  students = users.slice(0, 3);
  instructor = users[3];

  // Create a minimal set of assignments and gradebook columns (helper handles expressions and dependencies)
  const { assignments } = await createAssignmentsAndGradebookColumns({
    class_id: course.id,
    numAssignments: 4,
    numManualGradedColumns: 0,
    manualGradedColumnSlugs: ["participation"],
    groupConfig: "both"
  });
  //Add an individual submission for first assignment
  const submission1 = await insertPreBakedSubmission({
    student_profile_id: students[0].private_profile_id,
    assignment_id: assignments[0].id,
    class_id: course.id
  });
  //Add a group submission for second assignment
  const assignmentGroup = await supabase
    .from("assignment_groups")
    .insert({
      assignment_id: assignments[1].id,
      class_id: course.id,
      name: "E2ETestGroup"
    })
    .select("id")
    .single();
  if (assignmentGroup.error) {
    throw new Error(`Failed to create assignment group: ${assignmentGroup.error.message}`);
  }
  const assignmentGroupMember = await supabase.from("assignment_groups_members").insert({
    assignment_group_id: assignmentGroup.data!.id,
    profile_id: students[0].private_profile_id,
    assignment_id: assignments[1].id,
    class_id: course.id,
    added_by: instructor!.private_profile_id
  });
  if (assignmentGroupMember.error) {
    throw new Error(`Failed to create assignment group member: ${assignmentGroupMember.error.message}`);
  }
  const assignmentGroupMember2 = await supabase.from("assignment_groups_members").insert({
    assignment_group_id: assignmentGroup.data!.id,
    profile_id: students[1].private_profile_id,
    assignment_id: assignments[1].id,
    class_id: course.id,
    added_by: instructor!.private_profile_id
  });
  if (assignmentGroupMember2.error) {
    throw new Error(`Failed to create assignment group member: ${assignmentGroupMember2.error.message}`);
  }
  //Add a submission for the group
  const submission2 = await insertPreBakedSubmission({
    assignment_group_id: assignmentGroup.data!.id,
    assignment_id: assignments[1].id,
    class_id: course.id
  });

  const { error: submissionComment1Error } = await supabase
    .from("submission_comments")
    .insert({
      submission_id: submission1.submission_id,
      class_id: course.id,
      author: instructor!.private_profile_id,
      comment: "Good work on this aspect!",
      submission_review_id: submission1.grading_review_id,
      rubric_check_id: assignments[0].rubricChecks.find((check) => check.is_annotation)?.id,
      points: 90
    })
    .select("id");
  const { error: submissionComment2Error } = await supabase
    .from("submission_comments")
    .insert({
      submission_id: submission2.submission_id,
      class_id: course.id,
      author: instructor!.private_profile_id,
      comment: "Good work on this aspect!",
      submission_review_id: submission2.grading_review_id,
      rubric_check_id: assignments[1].rubricChecks.find((check) => check.is_annotation)?.id,
      points: 80
    })
    .select("id");
  if (submissionComment1Error || submissionComment2Error) {
    throw new Error(
      `Failed to create submission comments: ${submissionComment1Error?.message || submissionComment2Error?.message}`
    );
  }

  // Release submission review for assignment 1 and 2 only
  await supabase.from("submission_reviews").update({ released: true }).eq("id", submission1.grading_review_id);
  await supabase.from("submission_reviews").update({ released: true }).eq("id", submission2.grading_review_id);

  // Add a code walk for assignment 1
  const codeWalkRubric = await supabase
    .from("rubrics")
    .insert({
      assignment_id: assignments[0].id,
      class_id: course.id,
      name: "Code Walk",
      review_round: "code-walk"
    })
    .select("id")
    .single();
  if (codeWalkRubric.error) {
    throw new Error(`Failed to create code walk: ${codeWalkRubric.error.message}`);
  }
  // Populate with a single rubric part, criteria and check
  const codeWalkPart = await supabase
    .from("rubric_parts")
    .insert({
      class_id: course.id,
      name: "Code Walk",
      description: "Code Walk",
      ordinal: 0,
      rubric_id: codeWalkRubric.data!.id,
      assignment_id: assignments[0].id
    })
    .select("id")
    .single();
  if (codeWalkPart.error) {
    throw new Error(`Failed to create code walk part: ${codeWalkPart.error.message}`);
  }
  // Populate with a single rubric part, criteria and check
  const codeWalkCriteria = await supabase
    .from("rubric_criteria")
    .insert({
      class_id: course.id,
      name: "Code Walk",
      description: "Code Walk",
      ordinal: 0,
      total_points: 90,
      is_additive: true,
      rubric_part_id: codeWalkPart.data!.id,
      rubric_id: codeWalkRubric.data!.id,
      assignment_id: assignments[0].id
    })
    .select("id")
    .single();
  if (codeWalkCriteria.error) {
    throw new Error(`Failed to create code walk criteria: ${codeWalkCriteria.error.message}`);
  }
  // Populate with a single rubric part, criteria and check
  const codeWalkCheck = await supabase
    .from("rubric_checks")
    .insert({
      class_id: course.id,
      name: "Code Walk",
      description: "Code Walk",
      ordinal: 0,
      points: 90,
      is_annotation: false,
      is_comment_required: false,
      is_required: true,
      rubric_criteria_id: codeWalkCriteria.data!.id,
      assignment_id: assignments[0].id,
      rubric_id: codeWalkRubric.data!.id
    })
    .select("id")
    .single();
  if (codeWalkCheck.error) {
    throw new Error(`Failed to create code walk check: ${codeWalkCheck.error.message}`);
  }
  const submissionCodeWalkReview = await supabase
    .from("submission_reviews")
    .select("id")
    .eq("submission_id", submission1.submission_id)
    .eq("rubric_id", codeWalkRubric.data!.id)
    .single();
  if (submissionCodeWalkReview.error) {
    throw new Error(`Failed to create code walk review: ${submissionCodeWalkReview.error.message}`);
  }
  //Throw in a quick review for the code walk on submission 1
  const submissionCodeWalkComment = await supabase.from("submission_comments").insert({
    submission_id: submission1.submission_id,
    class_id: course.id,
    author: instructor!.private_profile_id,
    comment: "Good work on this aspect!",
    rubric_check_id: codeWalkCheck.data!.id,
    points: 90,
    submission_review_id: submissionCodeWalkReview.data!.id
  });
  if (submissionCodeWalkComment.error) {
    throw new Error(`Failed to create code walk comment: ${submissionCodeWalkComment.error.message}`);
  }
  await supabase
    .from("submission_reviews")
    .update({
      released: true
    })
    .eq("id", submissionCodeWalkReview.data!.id);
  console.log("Submission code walk review released in class", course.id);
  const { data: gradebookColumn, error: gradebookColumnError } = await supabase
    .from("gradebook_columns")
    .select("*")
    .eq("class_id", course.id)
    .eq("slug", "assignment-assignment-1-code-walk")
    .single();
  if (gradebookColumnError) {
    throw new Error(`Failed to get gradebook column: ${gradebookColumnError.message}`);
  }

  //Wait for gradebook to finish updating with the assignment code walk grades before starting the test
  await expect(async () => {
    const { data, error } = await supabase
      .from("gradebook_column_students")
      .select("*")
      .eq("class_id", course.id)
      .eq("student_id", students[0].private_profile_id)
      .eq("gradebook_column_id", gradebookColumn!.id)
      .eq("is_private", true)
      .single();
    if (error) {
      console.log(`Error getting gradebook column student data: ${error.message}`);
      throw new Error(`Failed to get gradebook column student data: ${error.message}`);
    }
    console.log(`Gradebook column student data: ${JSON.stringify(data)}`);
    expect(data?.score).toBe(90);
  }).toPass();

  //ALSO check for the final grade
  const { data: finalGradebookColumn, error: finalGradebookColumnError } = await supabase
    .from("gradebook_columns")
    .select("*")
    .eq("class_id", course.id)
    .eq("slug", "final-grade")
    .single();
  if (finalGradebookColumnError) {
    throw new Error(`Failed to get final gradebook column: ${finalGradebookColumnError.message}`);
  }

  //Wait for gradebook to finish updating with the final grade
  await expect(async () => {
    const { data, error } = await supabase
      .from("gradebook_column_students")
      .select("*")
      .eq("class_id", course.id)
      .eq("student_id", students[0].private_profile_id)
      .eq("gradebook_column_id", finalGradebookColumn!.id)
      .eq("is_private", true)
      .single();
    if (error) {
      throw new Error(`Failed to get gradebook column student data: ${error.message}`);
    }
    console.log(`Final gradebook column student data: ${JSON.stringify(data)}`);
    expect(data?.score).toBe(51.95);
  }).toPass();
  console.log("OK!");
}
async function batchTest() {
  for (let i = 0; i < 10; i++) {
    await Promise.all([test(), test(), test(), test(), test(), test(), test(), test(), test(), test()]);
    console.log("Completed batch", i);
  }
}

batchTest();
