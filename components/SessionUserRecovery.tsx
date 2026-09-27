"use client";

import { useEffect, useMemo } from "react";
import { installSessionUserRecovery } from "@/lib/sessionUserRecovery";
import { createClient } from "@/utils/supabase/client";

/**
 * Watches for the tab's auth session being replaced by a different user's (e.g.
 * a sign-in in another tab while this one sat in the background) and reloads so
 * the page matches the session it actually holds. Renders nothing; see
 * `lib/sessionUserRecovery.ts` for the detection + reload logic.
 *
 * `userId` is the user the surrounding tree was server-rendered for.
 */
export default function SessionUserRecovery({ userId }: { userId: string | null | undefined }) {
  const client = useMemo(() => createClient(), []);
  useEffect(() => {
    return installSessionUserRecovery({ client, renderedUserId: userId });
  }, [client, userId]);
  return null;
}
