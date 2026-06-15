import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { listAppInstallations } from "../_shared/GitHubWrapper.ts";
import type { ListGitHubOrgsResponse } from "../_shared/FunctionTypes.d.ts";
import { assertUserIsAdmin, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import * as Sentry from "npm:@sentry/deno";

async function handleRequest(req: Request, scope: Sentry.Scope): Promise<ListGitHubOrgsResponse> {
  scope?.setTag("function", "list-github-orgs");
  await assertUserIsAdmin(req.headers.get("Authorization"));
  const { orgs, installUrl } = await listAppInstallations(scope);
  return { orgs, installUrl };
}

Deno.serve(async (req) => {
  return wrapRequestHandler(req, handleRequest);
});
