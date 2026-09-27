/**
 * Token commands - token.info
 */

import { registerCommand } from "../router.ts";
import { getAdminClient } from "../utils/supabase.ts";
import type { MCPAuthContext } from "../../_shared/MCPAuth.ts";
import type { CLIResponse } from "../types.ts";

async function handleTokenInfo(ctx: MCPAuthContext, _params: Record<string, unknown>): Promise<CLIResponse> {
  const supabase = getAdminClient();

  const {
    data: { user }
  } = await supabase.auth.admin.getUserById(ctx.userId);

  // profiles is keyed on (id, class_id) and has no user_id column, so the
  // previous lookup by user_id always failed and the name was always null. The
  // display name lives on the auth user's metadata; a per-class profile name
  // would need a class to disambiguate, which this command does not take.
  const metadata = (user?.user_metadata ?? {}) as Record<string, unknown>;
  const metadataName =
    typeof metadata.name === "string"
      ? metadata.name
      : typeof metadata.full_name === "string"
        ? metadata.full_name
        : null;

  return {
    success: true,
    data: {
      user_id: ctx.userId,
      email: user?.email ?? null,
      name: metadataName,
      scopes: ctx.scopes,
      token_id: ctx.tokenId
    }
  };
}

registerCommand({
  name: "token.info",
  requiredScope: "public",
  handler: handleTokenInfo
});
