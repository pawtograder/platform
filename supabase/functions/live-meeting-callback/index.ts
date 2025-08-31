import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import * as chimeUtils from "../_shared/ChimeWrapper.ts";
import * as Sentry from "npm:@sentry/deno";

async function handleRequest(req: Request, scope: Sentry.Scope) {
  const body = await req.json();
  scope?.setTag("function", "live-meeting-callback");
  scope?.setContext("body", {
    body: body.body
  });
  //body is a string?
  if (typeof body.body === "string") {
    body.body = JSON.parse(body.body);
  }
  await chimeUtils.processSNSMessage(body.body);
  return "ok";
}

Deno.serve(async (req) => {
  const auth = req.headers.get("Authorization");
  if (auth !== Deno.env.get("AWS_CHIME_EVENT_AUTH_TOKEN")) {
    return new Response("Unauthorized", { status: 401 });
  }
  return await wrapRequestHandler(req, handleRequest);
});
