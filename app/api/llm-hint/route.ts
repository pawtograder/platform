import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import * as Sentry from "@sentry/nextjs";
import { GraderResultTestExtraData } from "@/utils/supabase/DatabaseTypes";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function POST(request: NextRequest) {
  try {
    // Check for required OpenAI configuration
    if (!process.env.OPENAI_API_KEY) {
      Sentry.captureMessage("OpenAI API key missing", "error");
      return NextResponse.json({ error: "OpenAI API key missing" }, { status: 500 });
    }

    const { testId } = await request.json();

    Sentry.setTag("testId", testId);

    if (!testId || typeof testId !== "number" || testId < 0 || !Number.isInteger(testId)) {
      return NextResponse.json({ error: "testId must be a non-negative integer" }, { status: 400 });
    }

    // Verify user has access to this test result
    const supabase = await createClient();
    const {
      data: { user }
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    Sentry.setUser({ id: user.id });

    // Try to get the test result - RLS will handle access control automatically
    const { data: testResult, error: testError } = await supabase
      .from("grader_result_tests")
      .select(
        `
        id,
        extra_data,
        grader_results!inner (
          submissions!inner (
            id
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
      return NextResponse.json({ error: "Test result not found or access denied" }, { status: 404 });
    }

    // Get the prompt from extra_data and check if hint already exists
    const extraData = testResult.extra_data as GraderResultTestExtraData | null;
    if (!extraData?.llm?.prompt) {
      return NextResponse.json({ error: "No LLM hint prompt found" }, { status: 400 });
    }

    // Check if hint has already been generated
    if (extraData.llm.result) {
      return NextResponse.json({
        success: true,
        response: extraData.llm.result,
        cached: true
      });
    }

    // Call OpenAI API with the prompt from the database
    const apiParams: any = {
      model: extraData.llm.model || process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: extraData.llm.prompt
        }
      ],
      user: `pawtograder:${user.id}`
    };

    // Only include optional parameters if they're explicitly set in extra_data
    if (extraData.llm.temperature !== undefined) {
      const temp = extraData.llm.temperature;
      if (typeof temp === "number" && temp >= 0 && temp <= 2) {
        apiParams.temperature = temp;
      }
    }

    if (extraData.llm.max_tokens !== undefined) {
      const maxTokens = extraData.llm.max_tokens;
      if (typeof maxTokens === "number" && maxTokens > 0) {
        apiParams.max_completion_tokens = maxTokens;
      }
    }

    const completion = await openai.chat.completions.create(apiParams);

    const aiResponse = completion.choices[0]?.message?.content;

    if (!aiResponse) {
      return NextResponse.json({ error: "No response from AI" }, { status: 500 });
    }

    // Store the result in the database
    const updatedExtraData: GraderResultTestExtraData = {
      ...extraData,
      llm: {
        ...extraData.llm,
        result: aiResponse
      }
    };

    // Use service role client for the update since users might not have update permissions
    const serviceSupabase = createServiceClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

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

    return NextResponse.json({
      success: true,
      response: aiResponse,
      usage: completion.usage,
      cached: false
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        operation: "llm_hint_api",
        testId: "unknown"
      },
      extra: {
        error: error instanceof Error ? error.message : String(error)
      }
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
