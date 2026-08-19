/**
 * CLI Edge Function
 *
 * Single edge function that handles all CLI commands.
 * Each CLI command maps to one POST request with a `command` field.
 *
 * Authentication: Requires valid API token with cli:read or cli:write scopes.
 *
 * Commands (the registry in router.ts is the source of truth; keep this list in
 * step with it):
 *
 *   PUBLIC (no scope check):
 *     - token.info
 *
 *   READ (cli:read):
 *     - classes.list
 *     - classes.show
 *     - assignments.list
 *     - assignments.show
 *     - discussions.list
 *     - flashcards.list
 *     - help_requests.list
 *     - repos.list
 *     - repos.sync_grade_workflow.context
 *     - repos.cross_assignment_copy.context
 *     - reviews.list
 *     - rubrics.list
 *     - rubrics.export
 *     - submissions.list
 *     - submissions.export (streaming)
 *     - assessment.export.preamble (streaming)
 *     - assessment.export.assignment (streaming)
 *     - assessment.export.gradebook (streaming)
 *     - assessment.export.roster (streaming)
 *
 *   WRITE (cli:write):
 *     - assignments.copy
 *     - assignments.delete
 *     - flashcards.copy
 *     - help_requests.close
 *     - reviews.assign
 *     - rubrics.import
 *     - submissions.comments.import
 *     - submissions.comments.sync
 *     - submissions.artifacts.import
 *     - surveys.copy
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import * as Sentry from "npm:@sentry/deno@10.10.0";
import { authenticateMCPRequest, MCPAuthError, updateTokenLastUsed } from "../_shared/MCPAuth.ts";
import { dispatch, dispatchStream, getCommand, UnknownCommandError } from "./router.ts";
import { isStreamCommand } from "./commands/base.ts";
import { corsHeaders } from "./utils/supabase.ts";
import { CLICommandError } from "./errors.ts";
import type { CLIRequest } from "./types.ts";

// Import command modules to trigger registration
import "./commands/token.ts";
import "./commands/classes.ts";
import "./commands/assignments.ts";
import "./commands/rubrics.ts";
import "./commands/flashcards.ts";
import "./commands/surveys.ts";
import "./commands/submissions.ts";
import "./commands/repos.ts";
import "./commands/assessment.ts";
import "./commands/discussions.ts";
import "./commands/helpRequests.ts";
import "./commands/reviews.ts";
import { normalizeEventFingerprint } from "../_shared/SentryFingerprint.ts";
import { sentryIdentity } from "../_shared/SentryContext.ts";
import { serveWithSentryFlush, waitUntilWithSentryFlush } from "../_shared/SentryInit.ts";

if (Deno.env.get("SENTRY_DSN")) {
  Sentry.init({
    beforeSend: normalizeEventFingerprint,
    ...sentryIdentity(),
    dsn: Deno.env.get("SENTRY_DSN")!
  });
}

serveWithSentryFlush(async (req) => {
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

    // Detached on purpose: the CLI response must not wait on a last-used
    // timestamp write. Routed through the background helper so the capture
    // updateTokenLastUsed now makes on failure is actually delivered — the
    // request-boundary flush has already run by the time this settles — and so
    // the isolate is kept alive until the write completes. The old empty
    // `.catch(() => {})` swallowed the outcome entirely.
    waitUntilWithSentryFlush(updateTokenLastUsed(authContext.tokenId));

    const body: CLIRequest = await req.json();

    if (!body.command || typeof body.command !== "string") {
      return new Response(JSON.stringify({ error: "Missing or invalid 'command' field" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Streaming commands take ownership of the Response (status + headers +
    // chunked body). The auth + scope check happens inside dispatchStream
    // before the stream is opened so 401/403 still surface as proper errors.
    const command = getCommand(body.command);
    if (command && isStreamCommand(command)) {
      return await dispatchStream(authContext, body, req);
    }

    const result = await dispatch(authContext, body);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (error) {
    // Only report what we could act on. An expired token, a missing scope, or a
    // typo'd command name is expected traffic for a public endpoint; reporting
    // every one of them buries real failures. Server faults (5xx) and anything
    // unrecognized still go to Sentry.
    if (error instanceof MCPAuthError) {
      if (error.shouldReport) {
        Sentry.captureException(error, { tags: { endpoint: "cli" } });
      }

      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    if (error instanceof CLICommandError) {
      if (error.status >= 500) {
        Sentry.captureException(error, { tags: { endpoint: "cli" } });
      }

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

    Sentry.captureException(error, { tags: { endpoint: "cli" } });

    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
