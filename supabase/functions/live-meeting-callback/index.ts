import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import * as chimeUtils from "../_shared/ChimeWrapper.ts";
import * as Sentry from "npm:@sentry/deno";
async function handleRequest(req: Request, scope: Sentry.Scope) {
  const body = await req.json();
  scope?.setTag("function", "live-meeting-callback");
  scope?.setTag("body", JSON.stringify(body));
  await chimeUtils.processSNSMessage(body);
  return "ok";
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
