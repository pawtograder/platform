import { createClient } from "jsr:@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serveWithSentryFlush } from "../_shared/SentryInit.ts";
import { REQUEST_SCOPED_AUTH_OPTIONS } from "../_shared/requestScopedAuthOptions.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { handleForgejoPush, handleForgejoWebhook } from "./webhook.ts";

// Push webhooks from Forgejo repositories (#1109). Forgejo calls this function directly, so it is
// authenticated by the hook's HMAC signature (FORGEJO_WEBHOOK_SECRET), not by a JWT.
serveWithSentryFlush((req) =>
  handleForgejoWebhook(req, {
    secret: Deno.env.get("FORGEJO_WEBHOOK_SECRET"),
    forgejoUrl: Deno.env.get("FORGEJO_URL"),
    handlePush: (push, scope) => {
      const adminSupabase = createClient<Database>(
        Deno.env.get("SUPABASE_URL") || "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
        { auth: REQUEST_SCOPED_AUTH_OPTIONS }
      );
      return handleForgejoPush(adminSupabase, push, scope);
    }
  })
);
