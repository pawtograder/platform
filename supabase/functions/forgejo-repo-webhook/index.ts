import { createClient } from "jsr:@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serveWithSentryFlush } from "../_shared/SentryInit.ts";
import { REQUEST_SCOPED_AUTH_OPTIONS } from "../_shared/requestScopedAuthOptions.ts";
import { forgejoConfig } from "../_shared/ForgejoWrapper.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { handleForgejoActionRun } from "./actionRun.ts";
import { handleForgejoPush, handleForgejoWebhook } from "./webhook.ts";

const adminClient = () =>
  createClient<Database>(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", {
    auth: REQUEST_SCOPED_AUTH_OPTIONS
  });

// Forgejo calls this directly, so it's authenticated by the hook's HMAC signature (FORGEJO_WEBHOOK_SECRET), not a JWT.
// Push-direct submissions (autograder off) also need the admin API settings, read by forgejoConfig().
serveWithSentryFlush((req) =>
  handleForgejoWebhook(req, {
    secret: Deno.env.get("FORGEJO_WEBHOOK_SECRET"),
    forgejoUrl: Deno.env.get("FORGEJO_URL"),
    handlePush: (push, scope) =>
      handleForgejoPush(adminClient(), push, scope, {
        forgejo: forgejoConfig(),
        adminLogin: Deno.env.get("FORGEJO_ADMIN_USERNAME")
      }),
    handleActionRun: (run, scope) => handleForgejoActionRun(adminClient(), run, scope)
  })
);
