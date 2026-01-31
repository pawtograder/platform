/**
 * AI Help Feedback Edge Function
 *
 * POST: Submit feedback on AI assistance experience
 *
 * Authentication: Requires valid Supabase session (dashboard login)
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import { Database } from "../_shared/SupabaseTypes.d.ts";

// Initialize Sentry if configured
if (Deno.env.get("SENTRY_DSN")) {
  Sentry.init({
    dsn: Deno.env.get("SENTRY_DSN")!,
    release: Deno.env.get("RELEASE_VERSION") || Deno.env.get("GIT_COMMIT_SHA")
  });
}

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

interface FeedbackRequest {
  class_id: number;
  context_type: "help_request" | "discussion_thread";
  resource_id: number;
  rating: "thumbs_up" | "thumbs_down";
  comment?: string;
}

/**
 * Authenticate user from Authorization header
 */
async function authenticateUser(authHeader: string | null) {
  if (!authHeader) {
    throw new Error("Missing Authorization header");
  }

  const supabase = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: {
      headers: { Authorization: authHeader }
    }
  });

  const token = authHeader.replace("Bearer ", "");
  const {
    data: { user },
    error
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    throw new Error("Unauthorized");
  }

  return { supabase, user };
}

/**
 * POST handler - Submit feedback on AI assistance
 */
async function handlePost(authHeader: string | null, body: FeedbackRequest): Promise<Response> {
  const { supabase, user } = await authenticateUser(authHeader);

  // Validate required fields
  if (!body.class_id || typeof body.class_id !== "number") {
    return new Response(JSON.stringify({ error: "class_id is required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  if (!body.context_type || !["help_request", "discussion_thread"].includes(body.context_type)) {
    return new Response(JSON.stringify({ error: "Invalid context_type" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  if (!body.resource_id || typeof body.resource_id !== "number") {
    return new Response(JSON.stringify({ error: "resource_id is required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  if (!body.rating || !["thumbs_up", "thumbs_down"].includes(body.rating)) {
    return new Response(JSON.stringify({ error: "Invalid rating" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Validate comment length if provided
  if (body.comment && body.comment.length > 2000) {
    return new Response(JSON.stringify({ error: "Comment too long (max 2000 characters)" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Check if user has instructor/grader role in this class
  const { data: roles, error: rolesError } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("class_id", body.class_id)
    .eq("disabled", false)
    .in("role", ["instructor", "grader"])
    .limit(1);

  if (rolesError || !roles || roles.length === 0) {
    return new Response(JSON.stringify({ error: "Feedback is only available to instructors and graders" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
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
    throw new Error("Failed to submit feedback");
  }

  return new Response(
    JSON.stringify({
      success: true,
      feedback_id: feedback.id,
      message: "Thank you for your feedback!"
    }),
    {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    }
  );
}

/**
 * Main handler
 */
Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const authHeader = req.headers.get("Authorization");

  try {
    if (req.method === "POST") {
      const body = await req.json();
      return await handlePost(authHeader, body);
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "ai_help_feedback" }
    });

    const message = error instanceof Error ? error.message : "Internal server error";
    const status = message === "Unauthorized" ? 401 : 500;

    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
