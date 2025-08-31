import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { AzureChatOpenAI, ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatPromptTemplate } from "@langchain/core/prompts";

import * as Sentry from "@sentry/nextjs";
import { GraderResultTestExtraData, LLMRateLimitConfig } from "@/utils/supabase/DatabaseTypes";

/**
 * Custom error class for errors that should be displayed to users
 * Use this for configuration issues, validation errors, etc. that users can act on
 */
class UserVisibleError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500
  ) {
    super(message);
    this.name = "UserVisibleError";
  }
}

async function getChatModel({
  model,
  provider,
  temperature,
  maxTokens,
  maxRetries,
  account
}: {
  model: string;
  provider: "openai" | "azure" | "anthropic";
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number;
  account?: string;
}) {
  Sentry.addBreadcrumb({
    message: "Getting chat model",
    level: "info",
    data: {
      model,
      provider
    }
  });
  if (provider === "azure") {
    const instanceName = process.env.AZURE_OPENAI_ENDPOINT?.split("/")[2];
    const key_env_name = account ? `AZURE_OPENAI_KEY_${account}` : "AZURE_OPENAI_KEY";
    if (!process.env.AZURE_OPENAI_ENDPOINT || !process.env[key_env_name]) {
      throw new UserVisibleError(`Azure OpenAI endpoint and key are required, must set env var ${key_env_name}`, 500);
    }
    return new AzureChatOpenAI({
      model,
      temperature: temperature || 0.85,
      maxTokens: maxTokens,
      maxRetries: maxRetries || 2,
      azureOpenAIApiKey: process.env[key_env_name],
      azureOpenAIApiInstanceName: instanceName,
      azureOpenAIApiDeploymentName: model,
      azureOpenAIApiVersion: "2024-05-01-preview"
    });
  } else if (provider === "openai") {
    const key_env_name = account ? `OPENAI_API_KEY_${account}` : "OPENAI_API_KEY";
    if (!process.env[key_env_name]) {
      throw new UserVisibleError(`OpenAI API key is required, must set env var ${key_env_name}`, 500);
    }
    return new ChatOpenAI({
      model,
      apiKey: process.env[key_env_name],
      temperature: temperature || 0.85,
      maxTokens: maxTokens,
      maxRetries: maxRetries || 2
    });
  } else if (provider === "anthropic") {
    const key_env_name = account ? `ANTHROPIC_API_KEY_${account}` : "ANTHROPIC_API_KEY";
    if (!process.env[key_env_name]) {
      throw new UserVisibleError(`Anthropic API key is required, must set env var ${key_env_name}`, 500);
    }
    return new ChatAnthropic({
      model,
      apiKey: process.env[key_env_name],
      temperature: temperature || 0.85,
      maxTokens: maxTokens,
      maxRetries: maxRetries || 2
    });
  }
  throw new UserVisibleError(`Invalid provider: ${provider}. Supported providers are: openai, azure, anthropic`, 400);
}

async function getPrompt(input: GraderResultTestExtraData["llm"]) {
  if (!input) {
    throw new UserVisibleError("LLM configuration is required", 400);
  }
  if (!input.prompt) {
    throw new UserVisibleError("LLM prompt is required", 400);
  }
  return ChatPromptTemplate.fromMessages([["human", input.prompt]]);
}

async function checkRateLimits(
  testResult: any,
  rateLimit: LLMRateLimitConfig,
  serviceSupabase: any
): Promise<string | null> {
  const submissionId = testResult.grader_results.submissions.id;
  const classId = testResult.class_id;
  const assignmentId = testResult.grader_results.submissions.assignment_id;

  // Check cooldown (minutes since last inference on this assignment, excluding current submission)
  if (rateLimit.cooldown) {
    const { data: lastUsage } = await serviceSupabase
      .from("llm_inference_usage")
      .select(`
        created_at,
        submissions!inner (
          assignment_id
        )
      `)
      .eq("submissions.assignment_id", assignmentId)
      .neq("submission_id", submissionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (lastUsage) {
      const minutesSinceLastUsage = Math.floor(
        (Date.now() - new Date(lastUsage.created_at).getTime()) / (1000 * 60)
      );
      
      if (minutesSinceLastUsage < rateLimit.cooldown) {
        const remainingMinutes = rateLimit.cooldown - minutesSinceLastUsage;
        return `Rate limit: Please wait ${remainingMinutes} more minute(s) before requesting Feedbot feedback for this assignment.`;
      }
    }
  }

  // Check assignment total limit
  if (rateLimit.assignment_total) {
    // First get all submissions for this assignment
    const { data: assignmentSubmissions } = await serviceSupabase
      .from("submissions")
      .select("id")
      .eq("assignment_id", assignmentId);

    if (assignmentSubmissions && assignmentSubmissions.length > 0) {
      const submissionIds = assignmentSubmissions.map((s: any) => s.id);
      
      // Count usage across all submissions for this assignment
      const { count: assignmentUsageCount } = await serviceSupabase
        .from("llm_inference_usage")
        .select("*", { count: "exact", head: true })
        .in("submission_id", submissionIds);

      if (assignmentUsageCount && assignmentUsageCount >= rateLimit.assignment_total) {
        return `Rate limit: Maximum number of Feedbot responses (${rateLimit.assignment_total}) for this assignment has been reached.`;
      }
    }
  }

  // Check class total limit
  if (rateLimit.class_total) {
    const { count: classUsageCount } = await serviceSupabase
      .from("llm_inference_usage")
      .select("*", { count: "exact", head: true })
      .eq("class_id", classId);

    if (classUsageCount && classUsageCount >= rateLimit.class_total) {
      return `Rate limit: Maximum number of Feedbot responses (${rateLimit.class_total}) for this class has been reached.`;
    }
  }

  return null; // No rate limiting issues
}

export async function POST(request: NextRequest) {
  try {
    const { testId } = await request.json();
    // eslint-disable-next-line no-console
    console.log("testId", testId);

    Sentry.setTag("testId", testId);

    if (!testId || typeof testId !== "number" || testId < 0 || !Number.isInteger(testId)) {
      throw new UserVisibleError("testId must be a non-negative integer", 400);
    }

    // Retrieve user
    const supabase = await createClient();
    const {
      data: { user }
    } = await supabase.auth.getUser();

    if (!user) {
      throw new UserVisibleError("Authentication required", 401);
    }

    Sentry.setUser({ id: user.id });

    // Try to get the test result - RLS will handle access control automatically
    const { data: testResult, error: testError } = await supabase
      .from("grader_result_tests")
      .select(
        `
        id,
        extra_data,
        class_id,
        grader_results!inner (
          submissions!inner (
            id,
            class_id,
            assignment_id
          )
        )
      `
      )
      .eq("id", testId)
      .single();

    if (testError || !testResult) {
      if (testError) {
        Sentry.captureException(testError, {
          tags: { operation: "fetch_test_result", testId: testId.toString() }
        });
      }
      throw new UserVisibleError("Test result not found or access denied", 404);
    }

    // Get the prompt from extra_data and check if hint already exists
    const extraData = testResult.extra_data as GraderResultTestExtraData | null;
    if (!extraData?.llm?.prompt) {
      throw new UserVisibleError("No LLM hint prompt found for this test", 400);
    }

    // Check if hint has already been generated
    if (extraData.llm.result) {
      return NextResponse.json({
        success: true,
        response: extraData.llm.result,
        cached: true
      });
    }

    // Use service role client for the update since users might not have update permissions
    const serviceSupabase = createServiceClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

    // Check rate limiting if configured
    if (extraData.llm.rate_limit) {
      
      const rateLimitError = await checkRateLimits(
        testResult,
        extraData.llm.rate_limit,
        serviceSupabase
      );
      if (rateLimitError) {
        throw new UserVisibleError(rateLimitError, 429);
      }
    }

    const modelName = extraData.llm.model || process.env.OPENAI_MODEL || "gpt-4o-mini";
    const providerName = extraData.llm.provider || "openai";
    const accountName = extraData.llm.account;

    const chatModel = await getChatModel({
      model: modelName,
      provider: providerName,
      temperature: extraData.llm.temperature,
      maxTokens: extraData.llm.max_tokens,
      account: extraData.llm.account
    });
    const prompt = await getPrompt(extraData.llm);
    const chain = prompt.pipe(chatModel);
    const response = await chain.invoke({
      input: extraData.llm.prompt
    });

    if (!response) {
      throw new UserVisibleError("No response received from AI provider", 500);
    }

    // Extract token usage from the response
    const inputTokens = response.usage_metadata?.input_tokens || 0;
    const outputTokens = response.usage_metadata?.output_tokens || 0;

    // Store the result in the database
    const updatedExtraData: GraderResultTestExtraData = {
      ...extraData,
      llm: {
        ...extraData.llm,
        result: response.content as string
      }
    };

 
    const { error: updateError } = await serviceSupabase
      .from("grader_result_tests")
      .update({ extra_data: updatedExtraData })
      .eq("id", testId);

    if (updateError) {
      Sentry.captureException(updateError, {
        tags: {
          operation: "store_llm_hint",
          testId: testId.toString()
        },
        extra: {
          updateError: updateError.message,
          testId
        }
      });
      // Still return the result even if storage fails
    }

    // Track LLM usage statistics
    const submissionId = testResult.grader_results.submissions.id;
    const classId = testResult.class_id;

    const { error: usageError } = await serviceSupabase.from("llm_inference_usage").insert({
      class_id: classId,
      created_by: user.id,
      grader_result_test_id: testId,
      submission_id: submissionId,
      account: accountName || "default",
      model: modelName,
      provider: providerName,
      input_tokens: inputTokens,
      output_tokens: outputTokens
    });

    if (usageError) {
      // Log usage tracking error but don't fail the request
      Sentry.captureException(usageError, {
        tags: {
          operation: "store_llm_usage",
          testId: testId.toString()
        },
        extra: {
          usageError: usageError.message,
          testId,
          inputTokens,
          outputTokens,
          model: modelName,
          provider: providerName
        }
      });
    }

    return NextResponse.json({
      success: true,
      response: response.content as string,
      cached: false
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Error in llm-hint API:", error);

    const errorMessage = error instanceof Error ? error.message : String(error);

    Sentry.captureException(error, {
      tags: {
        operation: "llm_hint_api"
      },
      extra: {
        error: errorMessage
      }
    });

    // If it's a UserVisibleError, return the message directly
    if (error instanceof UserVisibleError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }

    // For other errors, use a generic message to avoid exposing internal details
    return NextResponse.json({ error: "An unexpected error occurred. Please try again." }, { status: 500 });
  }
}
