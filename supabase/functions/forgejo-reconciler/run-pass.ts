/**
 * One forgejo-reconciler pass from the command line, for the Forgejo/Coder e2e lane, which runs
 * Supabase without the edge runtime. Prints the pass's counts and failures as JSON.
 *
 *   deno run --no-check --allow-env --allow-net --allow-read supabase/functions/forgejo-reconciler/run-pass.ts
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { forgejoConfig } from "../_shared/ForgejoWrapper.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { reconcileForgejo } from "./reconcile.ts";

const config = forgejoConfig();
const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!config || !url || !key) {
  throw new Error("Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and the four FORGEJO_* settings");
}
const { accounts, repos, hashes } = await reconcileForgejo(createClient<Database>(url, key), config);
console.log(
  JSON.stringify({
    accounts: accounts.provisioned,
    repos: repos.created,
    hashes: hashes.set,
    failures: [...accounts.failures, ...repos.failures, ...hashes.failures].map((f) => String(f.error))
  })
);
