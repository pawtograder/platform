/**
 * CLI Edge Function
 *
 * Single edge function that handles all CLI commands.
 * Each CLI command maps to one POST request with a `command` field.
 *
 * Authentication: Requires valid API token with cli:read or cli:write scopes.
 *
 * Commands:
 *   READ (cli:read):
 *     - classes.list
 *     - classes.show
 *     - assignments.list
 *     - assignments.show
 *     - rubrics.list
 *     - rubrics.export
 *     - flashcards.list
 *
 *   WRITE (cli:write):
 *     - assignments.copy
 *     - assignments.delete
 *     - rubrics.import
 *     - flashcards.copy
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import * as Sentry from "npm:@sentry/deno";
import { authenticateMCPRequest, MCPAuthError, updateTokenLastUsed } from "../_shared/MCPAuth.ts";
import { dispatch, UnknownCommandError } from "./router.ts";
import { corsHeaders } from "./utils/supabase.ts";
import { CLICommandError } from "./errors.ts";
import type { CLIRequest } from "./types.ts";

// Import command modules to trigger registration
import "./commands/token.ts";
import "./commands/classes.ts";
import "./commands/assignments.ts";
import "./commands/rubrics.ts";
import "./commands/flashcards.ts";

if (Deno.env.get("SENTRY_DSN")) {
  Sentry.init({
    dsn: Deno.env.get("SENTRY_DSN")!,
    release: Deno.env.get("RELEASE_VERSION") || Deno.env.get("GIT_COMMIT_SHA")
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed. Use POST." }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    const authContext = await authenticateMCPRequest(authHeader);

    updateTokenLastUsed(authContext.tokenId).catch(() => {});

    const body: CLIRequest = await req.json();

    if (!body.command || typeof body.command !== "string") {
      return new Response(JSON.stringify({ error: "Missing or invalid 'command' field" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const result = await dispatch(authContext, body);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "cli" }
    });

    if (error instanceof MCPAuthError) {
      const status =
        error.message === "Missing Authorization header" || error.message === "Invalid Authorization header format"
          ? 401
          : error.message.includes("Missing required scope")
            ? 403
            : error.message.includes("revoked")
              ? 401
              : 403;

      return new Response(JSON.stringify({ error: error.message }), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    if (error instanceof CLICommandError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    if (error instanceof UnknownCommandError) {
      return new Response(
        JSON.stringify({
          error: error.message,
          available_commands: error.availableCommands
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    }

    const message = error instanceof Error ? error.message : "Internal server error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
