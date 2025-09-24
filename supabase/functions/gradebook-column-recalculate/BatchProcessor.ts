import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as Sentry from "npm:@sentry/deno";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { processBatch } from "./index.ts";
export async function runHandler() {
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const scope = new Sentry.Scope();
  while (true) {
    const didWork = await processBatch(adminSupabase, scope, 1000);
    console.log(`Did work: ${didWork}`);
    if (!didWork) {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }
}

runHandler();
