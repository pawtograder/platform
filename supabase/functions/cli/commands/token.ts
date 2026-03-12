/**
 * Token commands - token.info
 */

import { registerCommand } from "../router.ts";
import { getAdminClient } from "../utils/supabase.ts";
import type { MCPAuthContext } from "../../_shared/MCPAuth.ts";
import type { CLIResponse } from "../types.ts";

async function handleTokenInfo(
  ctx: MCPAuthContext,
  _params: Record<string, unknown>
): Promise<CLIResponse> {
  const supabase = getAdminClient();

  const {
    data: { user }
  } = await supabase.auth.admin.getUserById(ctx.userId);

  const { data: profile } = await supabase
    .from("profiles")
    .select("name")
    .eq("user_id", ctx.userId)
    .single();

  return {
    success: true,
    data: {
      user_id: ctx.userId,
      email: user?.email ?? null,
      name: profile?.name ?? null,
      scopes: ctx.scopes,
      token_id: ctx.tokenId
    }
  };
}

registerCommand({
  name: "token.info",
  handler: handleTokenInfo
});
