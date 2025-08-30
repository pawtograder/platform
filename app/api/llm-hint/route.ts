import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function POST(request: NextRequest) {
  try {
    // Check for required OpenAI configuration
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: "OpenAI API key missing" }, { status: 500 });
    }

    const { testId } = await request.json();

    if (!testId) {
      return NextResponse.json({ error: "Missing testId" }, { status: 400 });
    }

    // Verify user has access to this test result
    const supabase = await createClient();
    const {
      data: { user }
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get the test result first
    const { data: testResult, error: testError } = await supabase
      .from("grader_result_tests")
      .select("id, extra_data, grader_result_id")
      .eq("id", testId)
      .single();

    if (testError || !testResult) {
      console.error("Test result query error:", testError);
      return NextResponse.json({ error: "Test result not found" }, { status: 404 });
    }

    // Get the grader result and submission info
    const { data: graderResult, error: graderError } = await supabase
      .from("grader_results")
      .select(
        `
        id,
        submission_id,
        submissions!inner(
          id,
          profile_id,
          assignment_group_id,
          assignment_id,
          class_id
        )
      `
      )
      .eq("id", testResult.grader_result_id)
      .single();

    if (graderError || !graderResult) {
      console.error("Grader result query error:", graderError);
      return NextResponse.json({ error: "Submission not found" }, { status: 404 });
    }

    const submission = graderResult.submissions;

    // Check if user has access
    let hasAccess = false;

    // Check if user is the submission owner (need to match against private_profile_id)
    const { data: userProfile } = await supabase
      .from("user_roles")
      .select("private_profile_id")
      .eq("user_id", user.id)
      .eq("class_id", submission.class_id)
      .single();

    if (userProfile && submission.profile_id === userProfile.private_profile_id) {
      hasAccess = true;
    }

    // Check if user is in the assignment group (if it exists)
    if (!hasAccess && submission.assignment_group_id && userProfile) {
      const { data: groupMember } = await supabase
        .from("assignment_groups_members")
        .select("profile_id")
        .eq("assignment_group_id", submission.assignment_group_id)
        .eq("profile_id", userProfile.private_profile_id)
        .single();

      if (groupMember) {
        hasAccess = true;
      }
    }

    // Check if user is instructor or grader for this class
    if (!hasAccess) {
      const { data: userRole } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("class_id", submission.class_id)
        .in("role", ["instructor", "grader"])
        .single();

      if (userRole) {
        hasAccess = true;
      }
    }

    if (!hasAccess) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // Get the prompt from extra_data and check if hint already exists
    const extraData = testResult.extra_data as { llm_hint_prompt?: string; llm_hint_result?: string } | null;
    if (!extraData?.llm_hint_prompt) {
      return NextResponse.json({ error: "No LLM hint prompt found" }, { status: 400 });
    }

    // Check if hint has already been generated
    if (extraData.llm_hint_result) {
      return NextResponse.json({
        success: true,
        response: extraData.llm_hint_result,
        cached: true
      });
    }

    // Call OpenAI API with the prompt from the database
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: extraData.llm_hint_prompt
        }
      ],
      max_tokens: 1000,
      temperature: 0.7
    });

    const aiResponse = completion.choices[0]?.message?.content;

    if (!aiResponse) {
      return NextResponse.json({ error: "No response from AI" }, { status: 500 });
    }

    // Store the result in the database
    const updatedExtraData = {
      ...extraData,
      llm_hint_result: aiResponse
    };

    // Use service role client for the update since users might not have update permissions
    const serviceSupabase = createServiceClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

    const { error: updateError } = await serviceSupabase
      .from("grader_result_tests")
      .update({ extra_data: updatedExtraData })
      .eq("id", testId);

    if (updateError) {
      console.error("Error storing LLM hint result:", updateError);
      // Still return the result even if storage fails
    }

    return NextResponse.json({
      success: true,
      response: aiResponse,
      usage: completion.usage,
      cached: false
    });
  } catch (error) {
    console.error("LLM Hint API Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
