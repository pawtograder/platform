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
import { LLMRateLimitConfig } from "@/utils/supabase/DatabaseTypes";
import { APIRequestContext } from "@playwright/test";

dotenv.config({ path: ".env.local", quiet: true });

// No env var exists for this account, so any request that gets past the rate limiter
// fails in getChatModel with a 500 instead of calling a real LLM provider.
const NO_KEY_ACCOUNT = "rate_limit_e2e_no_key";
const MISSING_KEY_ERROR = `OpenAI API key is required, must set env var OPENAI_API_KEY_${NO_KEY_ACCOUNT}`;
const ASSIGNMENT_TOTAL = 3;

let atLimitStudent: TestingUser;
let underLimitStudent: TestingUser;
let atLimitTestId: number;
let underLimitTestId: number;
let cooldownStudent: TestingUser;
let cooldownTestId: number;

async function getFirstGraderResultTestId(submission_id: number): Promise<number> {
  const { data, error } = await supabase
    .from("grader_result_tests")
    .select("id, grader_results!grader_result_tests_grader_result_id_fkey!inner(submission_id)")
    .eq("grader_results.submission_id", submission_id)
    .order("id", { ascending: true })
    .limit(1)
    .single();
  if (error || !data) {
    throw new Error(`Failed to get grader result test for submission ${submission_id}: ${error?.message}`);
  }
  return data.id;
}

/**
 * Creates a prior submission with `priorUses` llm_inference_usage rows (skipped when 0) and a current
 * submission whose first test has a Feedbot prompt with `rate_limit`. Returns the current test id.
 */
async function setUpStudent({
  student,
  class_id,
  assignment_id,
  priorUses,
  rate_limit
}: {
  student: TestingUser;
  class_id: number;
  assignment_id: number;
  priorUses: number;
  rate_limit: LLMRateLimitConfig;
}): Promise<number> {
  if (priorUses > 0) {
    const prior = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id,
      class_id
    });
    const priorTestId = await getFirstGraderResultTestId(prior.submission_id);
    const { error: usageError } = await supabase.from("llm_inference_usage").insert(
      Array.from({ length: priorUses }, () => ({
        class_id,
        created_by: student.user_id,
        grader_result_test_id: priorTestId,
        submission_id: prior.submission_id,
        account: NO_KEY_ACCOUNT,
        model: "gpt-4o-mini",
        provider: "openai",
        input_tokens: 0,
        output_tokens: 0
      }))
    );
    if (usageError) {
      throw new Error(`Failed to seed llm_inference_usage: ${usageError.message}`);
    }
  }

  const current = await insertPreBakedSubmission({
    student_profile_id: student.private_profile_id,
    assignment_id,
    class_id
  });
  const currentTestId = await getFirstGraderResultTestId(current.submission_id);
  const { error: updateError } = await supabase
    .from("grader_result_tests")
    .update({
      extra_data: {
        llm: {
          prompt: "Rate limit e2e test prompt",
          provider: "openai",
          model: "gpt-4o-mini",
          account: NO_KEY_ACCOUNT,
          rate_limit
        }
      }
    })
    .eq("id", currentTestId);
  if (updateError) {
    throw new Error(`Failed to set LLM prompt: ${updateError.message}`);
  }
  return currentTestId;
}

async function callLLMHintAPI(request: APIRequestContext, testId: number, student: TestingUser) {
  const authToken = await getAuthTokenForUser(student);
  const projectRef = process.env.NEXT_PUBLIC_SUPABASE_URL!.split("//")[1].split(".")[0];
  const cookieName = `sb-${projectRef}-auth-token`;
  const sessionData = {
    access_token: authToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "dummy-refresh-token",
    user: { id: student.user_id, email: student.email }
  };
  const response = await request.post("/api/llm-hint", {
    data: { testId },
    headers: {
      "Content-Type": "application/json",
      Cookie: `${cookieName}=${encodeURIComponent(JSON.stringify(sessionData))}`
    }
  });
  return { status: response.status(), body: (await response.json()) as { error?: string; success?: boolean } };
}

test.beforeAll(async () => {
  const course = await createClass({ name: "LLM Hint Rate Limit Test Class" });
  const users = await createUsersInClass([
    { role: "student", class_id: course.id },
    { role: "student", class_id: course.id },
    { role: "student", class_id: course.id }
  ]);
  [atLimitStudent, underLimitStudent, cooldownStudent] = users;
  const assignment = await insertAssignment({
    class_id: course.id,
    due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    name: "LLM Hint Rate Limit Assignment"
  });

  // Both students share the assignment, so the under-limit case also checks that
  // another student's usage is not counted against them.
  atLimitTestId = await setUpStudent({
    student: atLimitStudent,
    class_id: course.id,
    assignment_id: assignment.id,
    priorUses: ASSIGNMENT_TOTAL,
    rate_limit: { assignment_total: ASSIGNMENT_TOTAL }
  });
  underLimitTestId = await setUpStudent({
    student: underLimitStudent,
    class_id: course.id,
    assignment_id: assignment.id,
    priorUses: ASSIGNMENT_TOTAL - 1,
    rate_limit: { assignment_total: ASSIGNMENT_TOTAL }
  });

  // The cooldown check looks at all usage on the assignment, so this case gets an assignment
  // with no usage at all. The cooldown lookup then finds zero rows, which must not be treated as an error.
  const cooldownAssignment = await insertAssignment({
    class_id: course.id,
    due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    name: "LLM Hint Cooldown Assignment"
  });
  cooldownTestId = await setUpStudent({
    student: cooldownStudent,
    class_id: course.id,
    assignment_id: cooldownAssignment.id,
    priorUses: 0,
    rate_limit: { cooldown: 60 }
  });
});

test.describe("LLM Hint API rate limits", () => {
  test("returns 429 once the student has used assignment_total hints on other submissions", async ({ request }) => {
    const { status, body } = await callLLMHintAPI(request, atLimitTestId, atLimitStudent);
    expect(status).toBe(429);
    expect(body.error).toBe(
      `Rate limit: Maximum number of Feedbot responses (${ASSIGNMENT_TOTAL}) for this assignment has been reached.`
    );
  });

  test("does not rate limit a student below assignment_total", async ({ request }) => {
    const { status, body } = await callLLMHintAPI(request, underLimitTestId, underLimitStudent);
    // Past the rate limiter, the route fails on the missing provider key for NO_KEY_ACCOUNT.
    expect(status).toBe(500);
    expect(body.error).toBe(MISSING_KEY_ERROR);
  });

  test("does not block the first hint on an assignment when a cooldown is configured", async ({ request }) => {
    const { status, body } = await callLLMHintAPI(request, cooldownTestId, cooldownStudent);
    expect(status).toBe(500);
    expect(body.error).toBe(MISSING_KEY_ERROR);
  });
});
