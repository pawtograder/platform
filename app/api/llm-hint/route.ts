import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createClient as createServiceClient, SupabaseClient } from "@supabase/supabase-js";
import { AzureChatOpenAI, ChatOpenAI } from "@langchain/openai";
import { OpenAI as OpenAISDK } from "openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatPromptTemplate } from "@langchain/core/prompts";

import * as Sentry from "@sentry/nextjs";
import { GraderResultTestExtraData, LLMRateLimitConfig } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";

type GradrResultTestWithGraderResults = GetResult<
  Database["public"],
  Database["public"]["Tables"]["grader_result_tests"]["Row"],
  "grader_result_tests",
  Database["public"]["Tables"]["grader_result_tests"]["Relationships"],
  ` id,
        extra_data,
        class_id,
        grader_results!inner (
          submissions!grader_results_submission_id_fkey!inner (
            id,
            class_id,
            assignment_id,
            profile_id,
            assignment_group_id
          )
        )
      `
>;

/**
 * Custom error class for errors that should be displayed to users
 * Use this for configuration issues, validation errors, etc. that users can act on
 */
class UserVisibleError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public isBug: boolean = true
  ) {
    super(message);
    this.name = "UserVisibleError";
  }
}

/**
 * Adapter to make OpenAI SDK work like LangChain chat models
 * Needed to support reasoning models, since LangChain does not support them for AzureOpenAI
 */
class OpenAISDKAdapter {
  private client: OpenAISDK;
  private model: string;
  private maxTokens?: number;

  constructor(client: OpenAISDK, model: string, maxTokens?: number) {
    this.client = client;
    this.model = model;
    this.maxTokens = maxTokens;
  }

  async invoke(input: { input: string }) {
    try {
      // Back to chat completions with correct URL structure
      const requestParams: OpenAISDK.Chat.ChatCompletionCreateParams = {
        // Model is required by both OpenAI and Azure clients in the request body
        // (even though Azure may also include it in the URL path)
        model: this.model,
        messages: [
          { role: "developer", content: "You are a helpful assistant that provides feedback on code." },
          { role: "user", content: input.input }
        ]
      };

      // Only add supported parameters for reasoning models
      if (this.maxTokens) {
        requestParams.max_completion_tokens = this.maxTokens;
      }

      const response = await this.client.chat.completions.create(requestParams);

      // Adapt the response to match chat model format
      return {
        content: response.choices[0]?.message?.content || "",
        usage_metadata: {
          input_tokens: response.usage?.prompt_tokens || 0,
          output_tokens: response.usage?.completion_tokens || 0
        }
      };
    } catch (error) {
      Sentry.captureException(error, {
        tags: { operation: "openai_sdk_adapter" },
        extra: {
          model: this.model,
          maxTokens: this.maxTokens,
          errorDetails: error && typeof error === "object" && "error" in error ? error.error : undefined
        }
      });
      throw error;
    }
  }
}

// This is a bit clumsy, but not sure of a better option.
function isReasoningModel(model: string): boolean {
  // Match o1/o3/o4 and typical suffixes (e.g., -mini, -preview, -2024-08-06)
  return /^(?:o1|o3|o4)(?:[-._a-z0-9]+)?$/i.test(model);
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

    if (isReasoningModel(model)) {
      const client = new OpenAISDK({
        apiKey: process.env[key_env_name],
        baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${model}`,
        defaultQuery: { "api-version": "2025-03-01-preview" },
        defaultHeaders: {
          "api-key": process.env[key_env_name]
        }
      });
      return new OpenAISDKAdapter(client, model, maxTokens);
    } else {
      return new AzureChatOpenAI({
        model,
        temperature: temperature || 0.85,
        maxTokens: maxTokens,
        maxRetries: maxRetries || 2,
        azureOpenAIApiKey: process.env[key_env_name],
        azureOpenAIApiInstanceName: instanceName,
        azureOpenAIApiDeploymentName: model,
        azureOpenAIApiVersion: "2025-03-01-preview"
      });
    }
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
  testResult: GradrResultTestWithGraderResults,
  rateLimit: LLMRateLimitConfig,
  serviceSupabase: SupabaseClient<Database>
): Promise<string | null> {
  const submissionId = testResult.grader_results.submissions.id;
  const classId = testResult.class_id;
  const assignmentId = testResult.grader_results.submissions.assignment_id;

  // Check cooldown (minutes since last inference on this assignment, excluding current submission)
  if (rateLimit.cooldown) {
    const { data: lastUsage } = await serviceSupabase
      .from("llm_inference_usage")
      .select(
        `
        created_at,
        submissions!inner (
          assignment_id
        )
      `
      )
      .eq("submissions.assignment_id", assignmentId)
      .neq("submission_id", submissionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (lastUsage) {
      const minutesSinceLastUsage = Math.floor((Date.now() - new Date(lastUsage.created_at).getTime()) / (1000 * 60));

      if (minutesSinceLastUsage < rateLimit.cooldown) {
        const remainingMinutes = rateLimit.cooldown - minutesSinceLastUsage;
        return `Rate limit: Please wait ${remainingMinutes} more minute(s) before requesting Feedbot feedback for this assignment.`;
      }
    }
  }

  // Check assignment total limit
  if (rateLimit.assignment_total) {
    // Count usage across all matching submissions for this assignment using a single query
    const query = serviceSupabase
      .from("llm_inference_usage")
      .select("*", { count: "exact", head: true })
      .eq("submissions.assignment_id", assignmentId)
      .neq("submission_id", submissionId);

    if (testResult.grader_results.submissions.profile_id) {
      query.eq("submissions.profile_id", testResult.grader_results.submissions.profile_id);
    }
    if (testResult.grader_results.submissions.assignment_group_id) {
      query.eq("submissions.assignment_group_id", testResult.grader_results.submissions.assignment_group_id);
    }

    const { count: assignmentUsageCount } = await query;

    if (assignmentUsageCount && assignmentUsageCount >= rateLimit.assignment_total) {
      return `Rate limit: Maximum number of Feedbot responses (${rateLimit.assignment_total}) for this assignment has been reached.`;
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
          submissions!grader_results_submission_id_fkey!inner (
            id,
            class_id,
            assignment_id,
            profile_id,
            assignment_group_id
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
      const rateLimitError = await checkRateLimits(testResult, extraData.llm.rate_limit, serviceSupabase);
      if (rateLimitError) {
        throw new UserVisibleError(rateLimitError, 429, false);
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
    let response;
    if (isReasoningModel(modelName)) {
      // For reasoning models, bypass LangChain prompt template and call directly
      response = await (chatModel as OpenAISDKAdapter).invoke({
        input: extraData.llm.prompt
      });
    } else {
      // For regular models, use LangChain prompt template
      const prompt = await getPrompt(extraData.llm);
      if (chatModel instanceof ChatOpenAI || chatModel instanceof ChatAnthropic) {
        const chain = prompt.pipe(chatModel);
        response = await chain.invoke({
          input: extraData.llm.prompt
        });
      } else {
        throw new UserVisibleError("Unexpected model type for non-reasoning model", 500);
      }
    }

    if (!response) {
      throw new UserVisibleError("No response received from AI provider", 500);
    }

    // Extract token usage from the response
    const hasUsageMetadata = (
      obj: unknown
    ): obj is { usage_metadata?: { input_tokens?: number; output_tokens?: number } } =>
      typeof obj === "object" && obj !== null && "usage_metadata" in obj;

    const inputTokens = hasUsageMetadata(response) ? response.usage_metadata?.input_tokens || 0 : 0;
    const outputTokens = hasUsageMetadata(response) ? response.usage_metadata?.output_tokens || 0 : 0;

    const toText = (c: unknown) =>
      Array.isArray(c)
        ? c
            .map((b: unknown) => (typeof b === "string" ? b : b && typeof b === "object" && "text" in b ? b.text : ""))
            .filter(Boolean)
            .join("\n")
        : (c as string);

    const hasContent = (obj: unknown): obj is { content: unknown } =>
      typeof obj === "object" && obj !== null && "content" in obj;

    const resultText = toText(hasContent(response) ? response.content : "");

    // Check if the result is empty and throw an error if so
    if (!resultText || resultText.trim() === "") {
      throw new UserVisibleError(
        "AI provider returned an empty response. This may be due to content filtering or token limits.",
        500
      );
    }

    // Store the result in the database
    const updatedExtraData: GraderResultTestExtraData = {
      ...extraData,
      llm: {
        ...extraData.llm,
        result: resultText
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
      output_tokens: outputTokens,
      tags: {
        type: "grader_result_test_hint",
        hint_type: extraData.llm.type || "v1"
      }
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
      response: resultText,
      cached: false
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Error in llm-hint API:", error);

    // If it's a UserVisibleError, return the message directly
    if (error instanceof UserVisibleError) {
      if (error.isBug) {
        Sentry.captureException(error, {
          tags: {
            operation: "llm_hint_api"
          },
          extra: {
            error: error.message
          }
        });
      }
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    } else {
      Sentry.captureException(error, {
        tags: {
          operation: "llm_hint_api"
        }
      });
    }

    // For other errors, use a generic message to avoid exposing internal details
    return NextResponse.json({ error: "An unexpected error occurred. Please try again." }, { status: 500 });
  }
}
