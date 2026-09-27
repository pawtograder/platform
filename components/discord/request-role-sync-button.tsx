"use client";

import { createClient } from "@/utils/supabase/client";
import { Button } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import { toaster } from "../ui/toaster";

/**
 * Must match the throttle in request_discord_reinvite(). Duplicated rather than read from the server
 * for the same reason DiscordReinviteButton duplicates it: the button has to decide whether to
 * disable itself before it calls anything. The RPC stays the authority -- a client that gets this
 * wrong is told so by the zero it gets back.
 */
const RETRY_THROTTLE_MS = 5 * 60 * 1000;

/**
 * SQLSTATE the daily cap raises with. `53400` is configuration_limit_exceeded, which is what
 * PostgREST puts in `error.code`, and it is the only way to tell "you are out of retries for today"
 * apart from any other refusal without matching on the message text.
 */
const DAILY_LIMIT_SQLSTATE = "53400";

/**
 * A student's own "my roles have not appeared" button.
 *
 * Deliberately not the staff SyncRolesPanel's button. That one calls
 * trigger_discord_role_sync_for_user, which has no throttle of any kind, and pointing a
 * student-facing control at it is what makes a rate-limit problem for every class the bot serves --
 * Discord's limits are per-bot, not per-guild. This calls request_discord_reinvite, which throttles
 * per user per five minutes, caps a student at five a day, verifies the enrollment, and refuses to
 * act on anybody else's membership.
 *
 * The automatic request on returning to the dashboard covers the common case; this covers the one it
 * cannot see, where the student joined and then never left and re-entered the page.
 */
export default function RequestRoleSyncButton({ classId, userId }: { classId: number; userId: string }) {
  const [busy, setBusy] = useState(false);
  const [throttledUntil, setThrottledUntil] = useState(0);
  // Latched for the session once the server says the day's budget is gone. There is no client-side
  // countdown for it on purpose: the window rolls from the student's first press, so the only honest
  // source for when it reopens is the server, and pressing again to find out is exactly what the cap
  // exists to prevent.
  const [outOfRetries, setOutOfRetries] = useState(false);

  // Re-render when the throttle expires so the button re-enables itself without a reload.
  useEffect(() => {
    if (throttledUntil === 0) return;
    const remaining = throttledUntil - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setThrottledUntil(0), remaining);
    return () => clearTimeout(timer);
  }, [throttledUntil]);

  const run = async () => {
    setBusy(true);
    try {
      const { data, error } = await createClient().rpc("request_discord_reinvite", {
        p_class_id: classId,
        p_user_id: userId
      });

      if (error) {
        if (error.code === DAILY_LIMIT_SQLSTATE) {
          setOutOfRetries(true);
          toaster.create({ title: "Daily limit reached", description: error.message, type: "warning" });
          return;
        }
        toaster.create({ title: "Could not request a sync", description: error.message, type: "error" });
        return;
      }

      // RETURNS TABLE, so PostgREST sends a one-row array.
      const queued = data?.[0]?.queued ?? 0;
      if (queued > 0) {
        setThrottledUntil(Date.now() + RETRY_THROTTLE_MS);
        toaster.create({
          title: "Checking your Discord roles",
          description: "This usually takes about a minute. You do not need to stay on this page.",
          type: "success"
        });
        return;
      }

      // Queued nothing, and the reasons are not distinguishable from here: inside the five-minute
      // throttle, already recorded in the server, or the course's Discord roles were never created.
      // The first two need no action and the third needs an instructor, so the copy points at waiting
      // rather than at pressing again.
      setThrottledUntil(Date.now() + RETRY_THROTTLE_MS);
      toaster.create({
        title: "Already requested",
        description: "A check is already queued or ran in the last few minutes. Give it a minute to finish.",
        type: "info"
      });
    } finally {
      setBusy(false);
    }
  };

  const throttled = throttledUntil > Date.now();

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={run}
      loading={busy}
      disabled={busy || throttled || outOfRetries}
      alignSelf="flex-start"
    >
      {outOfRetries ? "Daily limit reached" : "My roles have not appeared"}
    </Button>
  );
}
