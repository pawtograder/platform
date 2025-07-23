import { addDays, subDays } from "date-fns";
import dotenv from "dotenv";
import { 
  createClass, 
  createUserInClass, 
  insertAssignment, 
  insertPreBakedSubmission,
  supabase,
  type TestingUser
} from "../tests/e2e/TestingUtils";

dotenv.config({ path: ".env.local" });

async function createDueDateException(assignment_id: number, student_profile_id: string, class_id: number, hoursExtension: number) {
  const { data: exceptionData, error: exceptionError } = await supabase
    .from("assignment_due_date_exceptions")
    .insert({
      class_id: class_id,
      assignment_id: assignment_id,
      student_id: student_profile_id,
      creator_id: student_profile_id,
      hours: hoursExtension,
      minutes: 0,
      tokens_consumed: Math.ceil(hoursExtension / 24)
    })
    .select("*")
    .single();

  if (exceptionError) {
    throw new Error(`Failed to create due date exception: ${exceptionError.message}`);
  }
  return exceptionData;
}

async function createRegradeRequest(submission_id: number, assignment_id: number, student_profile_id: string, grader_profile_id: string, class_id: number, status: "opened" | "resolved" | "closed") {
  // First create a submission comment to reference
  const { data: commentData, error: commentError } = await supabase
    .from("submission_comments")
    .insert({
      submission_id: submission_id,
      author: grader_profile_id,
      comment: "Test comment for regrade request",
      points: Math.floor(Math.random() * 10),
      class_id: class_id,
      released: true
    })
    .select("*")
    .single();

  if (commentError) {
    throw new Error(`Failed to create submission comment: ${commentError.message}`);
  }

  const { data: regradeData, error: regradeError } = await supabase
    .from("submission_regrade_requests")
    .insert({
      submission_id: submission_id,
      class_id: class_id,
      assignment_id: assignment_id,
      opened_at: new Date().toISOString(),
      created_by: student_profile_id,
      assignee: grader_profile_id,
      closed_by: status === "closed" ? grader_profile_id : null,
      closed_at: status === "closed" ? new Date().toISOString() : null,
      status: status,
      resolved_by: status === "resolved" || status === "closed" ? grader_profile_id : null,
      resolved_at: status === "resolved" || status === "closed" ? new Date().toISOString() : null,
      submission_comment_id: commentData.id, // Reference the comment we just created
      initial_points: Math.floor(Math.random() * 100),
      resolved_points: status === "resolved" || status === "closed" ? Math.floor(Math.random() * 100) : null,
      closed_points: status === "closed" ? Math.floor(Math.random() * 100) : null,
      last_updated_at: new Date().toISOString()
    })
    .select("*")
    .single();

  if (regradeError) {
    throw new Error(`Failed to create regrade request: ${regradeError.message}`);
  }
  return regradeData;
}

async function updateSubmissionReview(grading_review_id: number, grader_profile_id: string, isCompleted: boolean) {
  // Get the submission review details to find the rubric and submission
  const { data: reviewInfo, error: reviewError } = await supabase
    .from("submission_reviews")
    .select("id, submission_id, rubric_id, class_id")
    .eq("id", grading_review_id)
    .single();

  if (reviewError || !reviewInfo) {
    throw new Error(`Failed to get submission review: ${reviewError?.message}`);
  }

  if (isCompleted) {
    // Get all rubric checks for this rubric
    const { data: rubricChecks, error: checksError } = await supabase
      .from("rubric_checks")
      .select(`
        id, name, is_annotation, points, is_required, file,
        rubric_criteria!inner(id, rubric_id)
      `)
      .eq("rubric_criteria.rubric_id", reviewInfo.rubric_id);

    if (checksError) {
      throw new Error(`Failed to get rubric checks: ${checksError.message}`);
    }

    // Get submission files for annotation comments
    const { data: submissionFiles } = await supabase
      .from("submission_files")
      .select("id, name")
      .eq("submission_id", reviewInfo.submission_id);

    // Create comments for each rubric check
    for (const check of rubricChecks || []) {
      // 80% chance to apply non-required checks, 100% for required ones
      const shouldApply = check.is_required || Math.random() < 0.8;
      
      if (shouldApply) {
        const pointsAwarded = Math.floor(Math.random() * (check.points + 1)); // 0 to max points
        
        if (check.is_annotation) {
          // Create submission file comment (annotation)
          let file_id = null;
          
          if (check.file && submissionFiles) {
            const matchingFile = submissionFiles.find(f => f.name === check.file);
            file_id = matchingFile?.id || submissionFiles[0]?.id; // Use specified file or first available
          } else if (submissionFiles && submissionFiles.length > 0) {
            file_id = submissionFiles[Math.floor(Math.random() * submissionFiles.length)].id;
          }
          
          if (file_id) {
            await supabase.from("submission_file_comments").insert({
              submission_id: reviewInfo.submission_id,
              submission_file_id: file_id,
              author: grader_profile_id,
              comment: `${check.name}: Grading comment for this check`,
              points: pointsAwarded,
              line: Math.floor(Math.random() * 50) + 1, // Random line number
              class_id: reviewInfo.class_id,
              released: true,
              rubric_check_id: check.id,
              submission_review_id: grading_review_id
            });
          }
        } else {
          // Create submission comment (general comment)
          await supabase.from("submission_comments").insert({
            submission_id: reviewInfo.submission_id,
            author: grader_profile_id,
            comment: `${check.name}: ${pointsAwarded}/${check.points} points - ${check.name.includes('quality') ? 'Good work on this aspect!' : 'Applied this grading criteria'}`,
            points: pointsAwarded,
            class_id: reviewInfo.class_id,
            released: true,
            rubric_check_id: check.id,
            submission_review_id: grading_review_id
          });
        }
      }
    }
  }

  // Update the submission review
  const totalScore = isCompleted ? Math.floor(Math.random() * 100) : 0;
  const updateData = {
    grader: grader_profile_id,
    total_score: totalScore,
    released: isCompleted,
    completed_by: isCompleted ? grader_profile_id : null,
    completed_at: isCompleted ? new Date().toISOString() : null,
    total_autograde_score: Math.floor(Math.random() * 100)
  };

  const { data: reviewResult, error: updateError } = await supabase
    .from("submission_reviews")
    .update(updateData)
    .eq("id", grading_review_id)
    .select("*")
    .single();

  if (updateError) {
    throw new Error(`Failed to update submission review: ${updateError.message}`);
  }

  return reviewResult;
}

interface SeedingOptions {
  numStudents: number;
  numGraders: number;
  numAssignments: number;
  firstAssignmentDate: Date;
  lastAssignmentDate: Date;
}

async function seedInstructorDashboardData(options: SeedingOptions) {
  const { numStudents, numGraders, numAssignments, firstAssignmentDate, lastAssignmentDate } = options;
  
  console.log("🌱 Starting instructor dashboard data seeding...\n");
  console.log(`📊 Configuration:`);
  console.log(`   Students: ${numStudents}`);
  console.log(`   Graders: ${numGraders}`);
  console.log(`   Assignments: ${numAssignments}`);
  console.log(`   First Assignment: ${firstAssignmentDate.toISOString().split('T')[0]}`);
  console.log(`   Last Assignment: ${lastAssignmentDate.toISOString().split('T')[0]}\n`);

  try {
    // Create test class using TestingUtils
    const testClass = await createClass();
    const class_id = testClass.id;
    console.log(`✓ Created test class: ${testClass.name} (ID: ${class_id})`);

    // Create users using TestingUtils
    console.log("\n👥 Creating test users...");
    const instructor = await createUserInClass({ role: "instructor", class_id });
    
    const graders: TestingUser[] = [];
    for (let i = 1; i <= numGraders; i++) {
      graders.push(await createUserInClass({ role: "grader", class_id }));
      if (i % 10 === 0) {
        console.log(`  ✓ Created ${i} graders...`);
      }
    }
    
    const students: TestingUser[] = [];
    for (let i = 1; i <= numStudents; i++) {
      students.push(await createUserInClass({ role: "student", class_id }));
      if (i % 100 === 0) {
        console.log(`  ✓ Created ${i} students...`);
      }
    }
    console.log(`✓ Created ${students.length} students, 1 instructor, ${graders.length} graders`);

    // Create assignments using TestingUtils with evenly distributed dates
    console.log("\n📚 Creating test assignments...");
    const now = new Date();
    
    // Calculate evenly spaced dates between first and last assignment
    const timeDiff = lastAssignmentDate.getTime() - firstAssignmentDate.getTime();
    const timeStep = timeDiff / (numAssignments - 1);
    
    const assignments = [];
    for (let i = 0; i < numAssignments; i++) {
      const assignmentDate = new Date(firstAssignmentDate.getTime() + (timeStep * i));
      const assignment = await insertAssignment({ 
        due_date: assignmentDate.toISOString(), 
        class_id, 
        allow_not_graded_submissions: false 
      });
      assignments.push(assignment);
      
      if ((i + 1) % 10 === 0) {
        console.log(`  ✓ Created ${i + 1} assignments...`);
      }
    }

    console.log(`✓ Created ${assignments.length} assignments`);

    // Create submissions using TestingUtils
    console.log("\n📝 Creating submissions and reviews...");
    const submissionData: Array<{
      submission_id: number;
      assignment: typeof assignments[0];
      student: TestingUser;
    }> = [];

    // Pick students who will get extensions (10% of students)
    console.log("\n⏰ Selecting students for extensions...");
    const studentsWithExtensions = new Set<string>();
    const numStudentsForExtensions = Math.floor(students.length * 0.1); // 10% of students get extensions
    const shuffledStudents = [...students].sort(() => Math.random() - 0.5);
    for (let i = 0; i < Math.min(numStudentsForExtensions, shuffledStudents.length); i++) {
      studentsWithExtensions.add(shuffledStudents[i].private_profile_id);
    }
    console.log(`✓ Selected ${studentsWithExtensions.size} students for extensions`);

    for (const assignment of assignments) {
      const isRecentlyDue = new Date(assignment.due_date) < now;
      // Take all students but drop 1% randomly
      const submissionsForThisAssignment: Array<{ submission_id: number; student: TestingUser }> = [];
      
      for (const student of students) {
        // 95% chance student submitted (using TestingUtils)
        if (Math.random() < 0.95) {
          const { submission_id } = await insertPreBakedSubmission({
            student_profile_id: student.private_profile_id,
            assignment_id: assignment.id,
            class_id: class_id
          });
          
          submissionData.push({ submission_id, assignment, student });
          submissionsForThisAssignment.push({ submission_id, student });
        }
      }
      
      // For recently due assignments, update reviews (but skip students with extensions)
      if (isRecentlyDue && submissionsForThisAssignment.length > 0) {
        let reviewsUpdated = 0;
        for (const { submission_id, student } of submissionsForThisAssignment) {
          // Skip students who have extensions - their work is not yet graded
          if (studentsWithExtensions.has(student.private_profile_id)) {
            continue;
          }
          
          // Get the grading_review_id from the submission
          const { data: submissionInfo } = await supabase
            .from("submissions")
            .select("grading_review_id")
            .eq("id", submission_id)
            .single();
          
          if (submissionInfo?.grading_review_id) {
            const isCompleted = Math.random() < 0.95; // 95% chance review is completed
            const grader = graders[Math.floor(Math.random() * graders.length)];
            await updateSubmissionReview(submissionInfo.grading_review_id, grader.private_profile_id, isCompleted);
            reviewsUpdated++;
          }
        }
        if (reviewsUpdated > 0) {
          console.log(`  ✓ Updated ${reviewsUpdated} reviews for ${assignment.title} (skipped ${submissionsForThisAssignment.filter(s => studentsWithExtensions.has(s.student.private_profile_id)).length} students with extensions)`);
        }
      }
    }

        // Create due date exceptions (extensions) for selected students
    console.log("\n⏰ Creating due date extensions...");
    let extensionsCreated = 0;
    for (const { assignment, student } of submissionData) {
      // Only create extensions for students who were selected for extensions
      if (studentsWithExtensions.has(student.private_profile_id)) {
        await createDueDateException(assignment.id, student.private_profile_id, class_id, 5000);
        extensionsCreated++;
      }
    }
    console.log(`✓ Created ${extensionsCreated} due date extensions`);

    // Create regrade requests
    console.log("\n🔄 Creating regrade requests...");
    let regradeCount = 0;
    const statuses: Array<"opened" | "resolved" | "closed"> = ["opened", "resolved", "closed"];
    
    // Create regrade requests for 20% of submissions at random
    const numRegradeRequests = Math.max(1, Math.floor(submissionData.length * 0.2));
    // Shuffle the submissionData array
    const shuffledSubmissions = submissionData
      .map(value => ({ value, sort: Math.random() }))
      .sort((a, b) => a.sort - b.sort)
      .map(({ value }) => value)
      .slice(0, numRegradeRequests);

    for (const { submission_id, assignment, student } of shuffledSubmissions) {
      const status = statuses[Math.floor(Math.random() * statuses.length)];
      const grader = graders[Math.floor(Math.random() * graders.length)];
      await createRegradeRequest(submission_id, assignment.id, student.private_profile_id, grader.private_profile_id, class_id, status);
      regradeCount++;
    }
    console.log(`✓ Created ${regradeCount} regrade requests`);

    console.log("\n🎉 Database seeding completed successfully!");
    console.log(`\n📊 Summary:`);
    console.log(`   Class ID: ${class_id}`);
    console.log(`   Class Name: ${testClass.name}`);
    console.log(`   Assignments: ${assignments.length}`);
    console.log(`   Students: ${students.length}`);
    console.log(`   Submissions: ${submissionData.length}`);
    console.log(`   Extensions: ${extensionsCreated}`);
    console.log(`   Regrade Requests: ${regradeCount}`);
    console.log(`\n🔐 Instructor Login Credentials:`);
    console.log(`   Email: ${instructor.email}`);
    console.log(`   Password: ${instructor.password}`);
    console.log(`\n🔗 View the instructor dashboard at: /course/${class_id}`);

  } catch (error) {
    console.error("❌ Error seeding database:", error);
    process.exit(1);
  }
}

// Examples of different invocation patterns:

// Large-scale example (default)
export async function runLargeScale() {
  const now = new Date();
  
  await seedInstructorDashboardData({
    numStudents: 100,
    numGraders: 50,
    numAssignments: 40,
    firstAssignmentDate: subDays(now, 60), // 60 days in the past
    lastAssignmentDate: addDays(now, 50)   // 50 days in the future
  });
}

// Small-scale example for testing
async function runSmallScale() {
  const now = new Date();
  
  await seedInstructorDashboardData({
    numStudents: 10,
    numGraders: 2,
    numAssignments: 5,
    firstAssignmentDate: subDays(now, 30), // 15 days in the past
    lastAssignmentDate: addDays(now, 30)    // 7 days in the future
  });
}

// Run the large-scale example by default
// To run small-scale instead, change this to: runSmallScale()
async function main() {
//   await runLargeScale();
  // Uncomment below and comment above to run small scale:
  await runSmallScale();
}

main(); 