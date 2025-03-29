import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import * as chimeUtils from "../_shared/ChimeWrapper.ts";

async function handleRequest(req: Request) {
  const body = await req.json();
  await chimeUtils.processSNSMessage(body);
  return "ok";
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});

