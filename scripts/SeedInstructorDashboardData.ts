import { addDays, subDays } from "date-fns";
import dotenv from "dotenv";
import {
  createClass,
  createUserInClass,
  insertAssignment,
  insertPreBakedSubmission,
  gradeSubmission,
  createDueDateException,
  createRegradeRequest,
  supabase,
  type TestingUser
} from "../tests/e2e/TestingUtils";
import { Assignment } from "@/utils/supabase/DatabaseTypes";

dotenv.config({ path: ".env.local" });

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
  console.log(`   First Assignment: ${firstAssignmentDate.toISOString().split("T")[0]}`);
  console.log(`   Last Assignment: ${lastAssignmentDate.toISOString().split("T")[0]}\n`);

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
      const assignmentDate = new Date(firstAssignmentDate.getTime() + timeStep * i);
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
      assignment: (typeof assignments)[0];
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
            await gradeSubmission(submissionInfo.grading_review_id, grader.private_profile_id, isCompleted);
            reviewsUpdated++;
          }
        }
        if (reviewsUpdated > 0) {
          console.log(
            `  ✓ Updated ${reviewsUpdated} reviews for ${assignment.title} (skipped ${submissionsForThisAssignment.filter((s) => studentsWithExtensions.has(s.student.private_profile_id)).length} students with extensions)`
          );
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
      .map((value) => ({ value, sort: Math.random() }))
      .sort((a, b) => a.sort - b.sort)
      .map(({ value }) => value)
      .slice(0, numRegradeRequests);

    for (const { submission_id, assignment, student } of shuffledSubmissions) {
      const status = statuses[Math.floor(Math.random() * statuses.length)];
      const grader = graders[Math.floor(Math.random() * graders.length)];
      const rubric_check_id = assignment.rubricChecks[Math.random() < 0.5 ? 2 : 3].id;
      await createRegradeRequest(
        submission_id,
        assignment.id,
        student.private_profile_id,
        grader.private_profile_id,
        rubric_check_id,
        class_id,
        status
      );
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
    lastAssignmentDate: addDays(now, 50) // 50 days in the future
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
    lastAssignmentDate: addDays(now, 30) // 7 days in the future
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
