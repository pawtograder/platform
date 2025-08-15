import { check } from "k6";
import { Rate, Counter } from "k6/metrics";
import {
  getSupabaseConfig,
  createTestClass,
  createTestAssignment,
  createTestStudent,
  createTestRepository,
  createRepositoryCheckRun,
  createSubmission,
  generateTestRunPrefix,
  logCleanupInfo,
  type StudentData,
  type RepositoryData
} from "./k6-supabase";

// k6 globals
declare const __ENV: Record<string, string>;

// Custom metrics
export const submissionRate = new Rate("submission_success_rate");
export const submissionCounter = new Counter("submissions_created");
export const errorCounter = new Counter("submission_errors");

// Test configuration - Ramping arrival rate to 60 RPS
export const options = {
  scenarios: {
    ramping_load: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 100, // Pre-allocate VUs to handle peak load
      maxVUs: 200, // Maximum VUs if needed during peaks
      stages: [
        { duration: "1m", target: 20 }, // Ramp up to 60 RPS over 1 minute
        { duration: "2m", target: 20 }, // Maintain 60 RPS for 2 minutes
        { duration: "30s", target: 0 } // Ramp down to 0 RPS over 30 seconds
      ]
    }
  },
  thresholds: {
    submission_success_rate: ["rate>0.8"], // More lenient for initial testing
    http_req_duration: ["p(95)<5000"], // More lenient for complex operations
    submission_errors: ["count<50"] // Increased threshold for higher load
  }
};

// Data type for sharing between k6 phases
type TestData = {
  class_id: number;
  students: StudentData[];
  assignments: Array<{ id: number; title: string }>;
  repositories: RepositoryData[];
};

export async function setup() {
  console.log("🚀 Starting HTTP-based performance test setup...");

  try {
    const config = getSupabaseConfig();
    const testRunPrefix = generateTestRunPrefix("http-perf");

    // 1. Create class
    const classData = createTestClass(testRunPrefix, config);

    // 2. Create assignments
    console.log("📋 Creating test assignments...");
    const assignments = [];
    for (let i = 0; i < 3; i++) {
      // Create fewer assignments to reduce setup time
      try {
        const assignmentData = createTestAssignment(
          `HTTP Performance Test Assignment ${i + 1}`,
          classData.id,
          testRunPrefix,
          i,
          config
        );
        assignments.push({
          id: assignmentData.id,
          title: assignmentData.title
        });
      } catch (error) {
        console.log(`❌ Failed to create assignment ${i + 1}: ${error}`);
      }
    }

    // 3. Create students
    console.log("👥 Creating students...");
    const students = [];
    const workerIndex = process.env.TEST_WORKER_INDEX || "k6-worker";

    for (let i = 0; i < 5; i++) {
      // Create fewer students to reduce load
      const studentNumber = i + 1;
      try {
        const studentData = createTestStudent(studentNumber, classData.id, testRunPrefix, workerIndex, config);
        students.push(studentData);
      } catch (error) {
        console.log(`❌ Failed to create student ${studentNumber}: ${error}`);
      }
    }

    console.log(`✅ Created ${assignments.length} assignments and ${students.length} students`);

    // 4. Create repositories for each student-assignment pair
    console.log("🏗️ Creating repositories for student-assignment pairs...");
    const repositories = [];

    for (const student of students) {
      for (const assignment of assignments) {
        try {
          const repositoryData = createTestRepository(student, assignment, classData.id, testRunPrefix, config);
          repositories.push(repositoryData);
        } catch (error) {
          console.log(
            `❌ Failed to create repository for student ${student.id}, assignment ${assignment.id}: ${error}`
          );
        }
      }
    }

    console.log(
      `✅ Created ${repositories.length} repositories from ${students.length} students × ${assignments.length} assignments`
    );

    if (assignments.length === 0) {
      throw new Error("No assignments were created successfully - cannot proceed with performance test");
    }

    if (repositories.length === 0) {
      throw new Error("No repositories were created successfully - cannot proceed with performance test");
    }

    const setupResult: TestData = {
      class_id: classData.id,
      students,
      assignments,
      repositories
    };

    console.log("🎉 HTTP setup completed successfully!");
    console.log(`📊 Test data summary:
    - Class ID: ${classData.id}
    - Students: ${students.length}
    - Assignments: ${assignments.length}
    - Repositories: ${repositories.length}`);

    return setupResult;
  } catch (error) {
    console.error("❌ HTTP setup failed:", JSON.stringify(error, null, 2));
    console.error("❌ Error details:", error);
    console.error("❌ Error message:", error instanceof Error ? error.message : String(error));
    console.error("❌ Error stack:", error instanceof Error ? error.stack : "No stack trace");
    throw error;
  }
}

// Default export for k6 - this receives data from setup() function
// eslint-disable-next-line import/no-anonymous-default-export
export default function (data: TestData | undefined): void {
  if (!data) {
    console.error("❌ Test data not available - setup may have failed");
    errorCounter.add(1);
    submissionRate.add(false);
    return;
  }

  const config = getSupabaseConfig();
  const endToEndSecret = __ENV.END_TO_END_SECRET || "not-a-secret";

  const { class_id, repositories } = data;

  // Randomly select a pre-created repository (which has associated student and assignment)
  const randomRepository = repositories[Math.floor(Math.random() * repositories.length)];
  const { student: randomStudent, assignment: randomAssignment } = randomRepository;

  const startTime = Date.now();

  // Declare variables that need to be accessible in catch block
  const repository = randomRepository.name;
  const repository_id = randomRepository.id;

  try {
    const sha = `HEAD-${Math.random().toString(36).substring(2, 15)}`;

    // Create repository check run
    createRepositoryCheckRun(class_id, repository_id, sha, config);

    // Create submission via edge function
    const submissionResponse = createSubmission(repository, sha, config, endToEndSecret);

    const duration = Date.now() - startTime;

    console.log(`📊 Submission response status: ${submissionResponse.status}`);
    console.log(`⏱️ Request duration: ${duration}ms`);

    // Check if the submission was successful
    const success = submissionResponse.status === 200;

    if (success) {
      submissionRate.add(true);
      submissionCounter.add(1);

      const submissionData = submissionResponse.data;

      // Validate the result
      const validationSuccess = check(
        { status: submissionResponse.status, body: submissionResponse.body },
        {
          "submission API responded successfully": () => submissionResponse.status === 200,
          "response time under 5s": () => duration < 5000,
          "response contains grader_url": () => {
            return Boolean(
              submissionData &&
                typeof submissionData === "object" &&
                "grader_url" in submissionData &&
                typeof (submissionData as Record<string, unknown>).grader_url === "string"
            );
          }
        }
      );

      if (!validationSuccess) {
        errorCounter.add(1);
        console.error(
          `❌ Submission validation failed for student ${randomStudent.id}, assignment ${randomAssignment.id}`
        );
        console.error(`❌ Response body: ${submissionResponse.body}`);
      } else {
        const submissionId = (submissionData as Record<string, unknown>)?.submission_id || "unknown";
        console.log(
          `✅ Submission created successfully! Submission ID: ${submissionId}, Duration: ${duration}ms, Repository: ${repository}`
        );
      }
    } else {
      // Record failed submission
      submissionRate.add(false);
      errorCounter.add(1);

      console.error(`❌ Submission failed for student ${randomStudent.id}, assignment ${randomAssignment.id}`);
      console.error(`❌ HTTP Status: ${submissionResponse.status}`);
      console.error(`❌ Response body: ${submissionResponse.body}`);
      console.error(`❌ Repository: ${repository}`);
      console.error(`❌ SHA: ${sha}`);

      // Try to parse error response
      if (submissionResponse.data) {
        console.error(`❌ Parsed error data: ${JSON.stringify(submissionResponse.data, null, 2)}`);
      }

      check(null, {
        "submission did not fail": () => false
      });
    }
  } catch (error) {
    // Record failed submission
    submissionRate.add(false);
    errorCounter.add(1);

    console.error(`❌ Submission failed for student ${randomStudent.id}, assignment ${randomAssignment.id}`);
    console.error(`❌ Exception thrown: ${error}`);
    console.error(`❌ Error message: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`❌ Error stack: ${error instanceof Error ? error.stack : "No stack trace"}`);

    // Log context information for debugging
    console.error(`❌ Context - Repository: ${repository}`);
    console.error(`❌ Context - Repository ID: ${repository_id}`);
    console.error(`❌ Context - Class ID: ${class_id}`);
    console.error(`❌ Context - Assignment ID: ${randomAssignment.id}`);
    console.error(`❌ Context - Student ID: ${randomStudent.id}`);

    check(null, {
      "submission did not fail": () => false
    });
  }
}

// Teardown function
export function teardown(data: TestData | undefined): void {
  if (data && data.class_id) {
    logCleanupInfo(data.class_id, "HTTP");
  }
}

/*
HTTP Performance Test for Real Submission Creation

This test replicates the exact same API calls as insertSubmissionViaAPI:
1. Creates repository records in the database
2. Creates repository check runs
3. Signs JWT tokens with END_TO_END_SECRET
4. Calls autograder-create-submission edge function

Usage examples:

1. Basic test (5 VUs for 30 seconds):
   npm run test:k6:http

2. Medium load (10 VUs for 60 seconds):
   k6 run -e SUBMISSION_RATE=10 -e TEST_DURATION=60s dist/k6-tests/db-tps-http.js

3. Higher load (20 VUs for 2 minutes):
   k6 run -e SUBMISSION_RATE=20 -e TEST_DURATION=2m dist/k6-tests/db-tps-http.js

Environment variables required:
- SUPABASE_URL: Your Supabase project URL  
- SUPABASE_SERVICE_ROLE_KEY: Your Supabase service role key
- END_TO_END_SECRET: Secret for JWT authentication (defaults to 'not-a-secret')

What this tests:
- Database performance under submission load
- Edge function performance
- End-to-end submission creation flow
- JWT token validation and processing
*/
