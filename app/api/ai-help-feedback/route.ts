import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import * as Sentry from "@sentry/nextjs";

/**
 * AI Help Feedback API
 *
 * POST: Submit feedback on AI assistance experience
 */

interface FeedbackRequest {
  class_id: number;
  context_type: "help_request" | "discussion_thread";
  resource_id: number;
  rating: "thumbs_up" | "thumbs_down";
  comment?: string;
}

/**
 * POST /api/ai-help-feedback
 * Submit feedback on AI assistance
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const supabase = await createClient();

    // Get current user
    const {
      data: { user },
      error: userError
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Parse request body
    let body: FeedbackRequest;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Validate required fields
    if (!body.class_id || typeof body.class_id !== "number") {
      return NextResponse.json({ error: "class_id is required" }, { status: 400 });
    }

    if (!body.context_type || !["help_request", "discussion_thread"].includes(body.context_type)) {
      return NextResponse.json({ error: "Invalid context_type" }, { status: 400 });
    }

    if (!body.resource_id || typeof body.resource_id !== "number") {
      return NextResponse.json({ error: "resource_id is required" }, { status: 400 });
    }

    if (!body.rating || !["thumbs_up", "thumbs_down"].includes(body.rating)) {
      return NextResponse.json({ error: "Invalid rating" }, { status: 400 });
    }

    // Validate comment length if provided
    if (body.comment && body.comment.length > 2000) {
      return NextResponse.json({ error: "Comment too long (max 2000 characters)" }, { status: 400 });
    }

    // Check if user has instructor/grader role in this class
    const { data: roles } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("class_id", body.class_id)
      .eq("disabled", false)
      .in("role", ["instructor", "grader"]);

    if (!roles || roles.length === 0) {
      return NextResponse.json({ error: "Feedback is only available to instructors and graders" }, { status: 403 });
    }

    // Insert feedback
    const { data: feedback, error: insertError } = await supabase
      .from("ai_help_feedback")
      .insert({
        user_id: user.id,
        class_id: body.class_id,
        context_type: body.context_type,
        resource_id: body.resource_id,
        rating: body.rating,
        comment: body.comment?.trim() || null
      })
      .select("id, created_at")
      .single();

    if (insertError) {
      Sentry.captureException(insertError, {
        tags: { endpoint: "ai_help_feedback", operation: "create" }
      });
      return NextResponse.json({ error: "Failed to submit feedback" }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      feedback_id: feedback.id,
      message: "Thank you for your feedback!"
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "ai_help_feedback", operation: "create" }
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
