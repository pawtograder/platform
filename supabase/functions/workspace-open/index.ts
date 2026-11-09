import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import { openWorkspace } from "../_shared/CoderWorkspace.ts";
import { workspaceRequestContext } from "../_shared/CoderWorkspaceDb.ts";
import type { WorkspaceOpenResponse } from "../_shared/FunctionTypes.d.ts";
import { wrapRequestHandler } from "../_shared/HandlerUtils.ts";

// The Open in Coder button (#1095): creates the caller's Coder user and workspace if missing, starts
// the workspace if it's stopped, and says where to send them.
async function handleRequest(req: Request, scope: Sentry.Scope): Promise<WorkspaceOpenResponse> {
  const { deps, caller, request } = await workspaceRequestContext(req);
  scope.setTag("assignment_id", String(request.assignment_id));
  return await openWorkspace(deps, caller, request);
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
