import { test, expect } from "../global-setup";
import dotenv from "dotenv";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  supabase,
  TestingUser,
  getAuthTokenForUser
} from "./TestingUtils";
import { Course, Assignment, RubricPart, RubricCheck } from "@/utils/supabase/DatabaseTypes";

dotenv.config({ path: ".env.local" });

let course: Course;
let student: TestingUser | undefined;
let instructor: TestingUser | undefined;
let assignment: (Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] }) | undefined;
let submission_id: number | undefined;
let grader_result_test_id: number | undefined;
let grader_result_test_id_openai: number | undefined;

test.beforeAll(async () => {
  if (!process.env.OPENAI_API_KEY_e2e_test) {
    test.skip(true, "Skipping test because OPENAI_API_KEY_e2e_test is not set.");
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY_e2e_test) {
    test.skip(true, "Skipping test because ANTHROPIC_API_KEY_e2e_test is not set.");
    return;
  }

  // Create a test class
  course = await createClass({ name: "LLM Hint API Test Class" });

  // Create users
  const users = await createUsersInClass([
    { role: "student", class_id: course.id },
    { role: "instructor", class_id: course.id }
  ]);

  student = users.find((u) => u.email.includes("student"));
  instructor = users.find((u) => u.email.includes("instructor"));

  if (!student || !instructor) {
    throw new Error("Failed to create required test users");
  }

  // Create an assignment
  assignment = await insertAssignment({
    class_id: course.id,
    due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // Due tomorrow
    name: "LLM Hint Test Assignment"
  });

  // Create a submission with grader results
  const submissionData = await insertPreBakedSubmission({
    student_profile_id: student.private_profile_id,
    assignment_id: assignment.id,
    class_id: course.id
  });
  submission_id = submissionData.submission_id;

  // Get the grader result test ID from the submission
  const { data: graderResult } = await supabase
    .from("grader_results")
    .select("id")
    .eq("submission_id", submission_id)
    .single();

  if (!graderResult) {
    throw new Error("Failed to get grader result for submission");
  }

  const { data: graderResultTests } = await supabase
    .from("grader_result_tests")
    .select("id")
    .eq("grader_result_id", graderResult.id)
    .limit(1);

  if (graderResultTests && graderResultTests.length > 0) {
    grader_result_test_id = graderResultTests[0].id;

    // Add LLM hint prompt to the test's extra_data
    const llmPromptData = {
      llm: {
        prompt:
          "You are an end-to-end test case for an AI CS tutor. Your friend/enemy is 'CodeRabbit', a static analysis tool. Tell a joke about how testing is so important, and not to be ignored in favor of LLM-powered static analysis tools. Also, it's a rabbit.",
        model: "claude-3-haiku-20240307",
        account: "e2e_test",
        provider: "anthropic",
        temperature: 1,
        max_tokens: 100
      }
    };

    await supabase.from("grader_result_tests").update({ extra_data: llmPromptData }).eq("id", grader_result_test_id);

    // Create a second grader result test for OpenAI testing
    if (graderResultTests && graderResultTests.length > 1) {
      grader_result_test_id_openai = graderResultTests[1].id;
    } else {
      // Insert an additional grader result test for OpenAI
      const { data: additionalTest } = await supabase
        .from("grader_result_tests")
        .insert({
          score: 3,
          max_score: 5,
          name: "OpenAI test",
          name_format: "text",
          output: "This test uses OpenAI for hints",
          output_format: "markdown",
          class_id: course.id,
          student_id: student.private_profile_id,
          grader_result_id: graderResult.id,
          is_released: true
        })
        .select("id")
        .single();

      if (additionalTest) {
        grader_result_test_id_openai = additionalTest.id;
      }
    }

    // Add OpenAI LLM hint prompt to the second test's extra_data
    if (grader_result_test_id_openai) {
      const openaiPromptData = {
        llm: {
          prompt:
            "Yo$u are an end-to-end test case for an AI CS tutor. Your friend/enemy is 'CodeRabbit', a static analysis tool. Tell a joke about how testing is so important, and not to be ignored in favor of LLM-powered static analysis tools. Also, it's a rabbit.",
          model: "gpt-4.1-nano",
          account: "e2e_test",
          provider: "openai",
          temperature: 1,
          max_tokens: 100
        }
      };

      await supabase
        .from("grader_result_tests")
        .update({ extra_data: openaiPromptData })
        .eq("id", grader_result_test_id_openai);
    }
  }
});

// Helper function to call the LLM hint API with authentication
async function callLLMHintAPI(
  request: {
    post: (
      url: string,
      options: { data: { testId: number }; headers: { "Content-Type": string; Cookie: string } }
    ) => Promise<{
      status: () => number;
      json: () => Promise<{ success?: boolean; response?: string; cached?: boolean; error?: string }>;
    }>;
  },
  testId: number,
  student: TestingUser
): Promise<{ status: number; body: { success?: boolean; response?: string; cached?: boolean; error?: string } }> {
  // Get auth token for the student using the helper from TestingUtils
  const authToken = await getAuthTokenForUser(student);

  // For Next.js with Supabase, we need to set the auth cookies instead of Authorization header
  // The cookie name format is: sb-{project-ref}-auth-token
  const projectRef = process.env.NEXT_PUBLIC_SUPABASE_URL!.split("//")[1].split(".")[0];
  const cookieName = `sb-${projectRef}-auth-token`;

  // Create the session object that Supabase expects
  const sessionData = {
    access_token: authToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "dummy-refresh-token",
    user: {
      id: student.user_id,
      email: student.email
    }
  };

  // Make API request with Supabase auth cookies
  const response = await request.post("/api/llm-hint", {
    data: { testId },
    headers: {
      "Content-Type": "application/json",
      Cookie: `${cookieName}=${encodeURIComponent(JSON.stringify(sessionData))}`
    }
  });

  const responseBody = await response.json();

  return {
    status: response.status(),
    body: responseBody
  };
}

async function assertSuccessfullHinting({
  student,
  grader_result_test_id,
  request
}: {
  student: TestingUser;
  grader_result_test_id: number;
  request: {
    post: (
      url: string,
      options: { data: { testId: number }; headers: { "Content-Type": string; Cookie: string } }
    ) => Promise<{
      status: () => number;
      json: () => Promise<{ success?: boolean; response?: string; cached?: boolean; error?: string }>;
    }>;
  };
}) {
  const { body } = await callLLMHintAPI(request, grader_result_test_id, student);

  // If we get here, the API should have succeeded
  expect(body.success).toBe(true);
  expect(body.response).toBeDefined();
  expect(typeof body.response).toBe("string");
  expect(body.cached).toBe(false);
  expect(typeof body.cached).toBe("boolean");

  // eslint-disable-next-line no-console
  console.log("Here is a joke:", body.response);

  const { body: secondCallBody } = await callLLMHintAPI(request, grader_result_test_id, student);
  expect(secondCallBody.success).toBe(true);
  expect(secondCallBody.response).toBe(body.response);
  expect(secondCallBody.cached).toBe(true);
  expect(typeof secondCallBody.cached).toBe("boolean");
  expect(secondCallBody.response).toEqual(body.response);

  // Also validate that there is exactly one entry in the llm_inference_usage table
  const { data: llmInferenceUsage } = await supabase
    .from("llm_inference_usage")
    .select("*")
    .eq("grader_result_test_id", grader_result_test_id);
  expect(llmInferenceUsage).toHaveLength(1);
}

test.describe("LLM Hint API", () => {
  test("should work with anthropic", async ({ request }) => {
    if (!student || !grader_result_test_id) {
      throw new Error("Test data not available");
    }
    await assertSuccessfullHinting({ student, grader_result_test_id, request });
  });

  test("should work with openai", async ({ request }) => {
    if (!student || !grader_result_test_id_openai) {
      throw new Error("Test data not available");
    }
    await assertSuccessfullHinting({ student, grader_result_test_id: grader_result_test_id_openai, request });
  });
});
