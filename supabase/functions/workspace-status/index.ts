import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import { STATUS_BUDGET_MS, workspaceStatus, startBudget, withinBudget } from "../_shared/CoderWorkspace.ts";
import { workspaceRequestContext } from "../_shared/CoderWorkspaceDb.ts";
import type { WorkspaceOpenResponse } from "../_shared/FunctionTypes.d.ts";
import { wrapRequestHandler } from "../_shared/HandlerUtils.ts";

// What #1095's progress card polls: the caller's workspace build and agent state, and the failing
// step. Creates and starts nothing.
async function handleRequest(req: Request, scope: Sentry.Scope): Promise<WorkspaceOpenResponse> {
  // From the start of the request, so the sign-in check counts too.
  const budget = startBudget(STATUS_BUDGET_MS);
  return await withinBudget(budget, async () => {
    const { deps, caller, request } = await workspaceRequestContext(req, budget);
    scope.setTag("assignment_id", String(request.assignment_id));
    return await workspaceStatus(deps, caller, request);
  });
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
