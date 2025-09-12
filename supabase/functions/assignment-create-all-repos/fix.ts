import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as Sentry from "npm:@sentry/deno";
import { createAllRepos } from "./index.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.3/dist/module/index.js";
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

const adminSupabase = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOnce() {
  const scope = new Sentry.Scope();
  //Find all released assignments for classes with slug f25
  // const f25Classes = await adminSupabase.from("classes").select("*").eq("slug", "f25").limit(1000);
  // if (f25Classes.error) {
  // throw new Error("Error fetching f25 classes");
  // }
  const { data: assignments, error: assignmentsError } = await adminSupabase
    .from("assignments")
    .select("*, classes(name)")
    // .in("class_id", f25Classes.data?.map((c) => c.id) ?? [])
    .eq("class_id", 33)
    .lte("release_date", new Date().toISOString())
    .limit(1000);
  if (assignmentsError) {
    throw new Error("Error fetching assignments");
  }
  for (const assignment of assignments) {
    console.log(`Creating repos for assignment ${assignment.title} in class ${assignment.classes.name}`);
    await createAllRepos(assignment.class_id, assignment.id, scope);
  }
  // await createAllRepos(32, 406, scope);
}

async function daemon() {
  while (true) {
    const start = Date.now();
    try {
      await runOnce();
    } catch (error: unknown) {
      // Ensure errors don't break the loop
      try {
        // Prefer Sentry if configured
        Sentry.captureException(error);
        console.error(error);
      } catch {
        // ignore sentry capture errors
      }
    }
    const elapsed = Date.now() - start;
    const waitMs = Math.max(0, FIFTEEN_MINUTES_MS - elapsed);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }
}

daemon();
