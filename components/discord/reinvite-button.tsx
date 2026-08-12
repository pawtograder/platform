"use client";

import { createClient } from "@/utils/supabase/client";
import type { DiscordMembershipRow } from "@/hooks/useDiscordMembershipStatus";
import { Button } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import { toaster } from "../ui/toaster";

/**
 * Must match the throttle in request_discord_reinvite(). Duplicated rather than read from the server
 * because the button has to decide whether to disable itself before it calls anything; the RPC stays
 * the authority, and a client that gets this wrong is told so by the zero it gets back.
 */
const RETRY_THROTTLE_MS = 5 * 60 * 1000;

/** True when at least one of these rows is outside the throttle window, so a retry would do something. */
export function canRetryAny(rows: DiscordMembershipRow[], now: number = Date.now()): boolean {
  return rows.some(
    (row) => !row.last_retry_requested_at || now - new Date(row.last_retry_requested_at).getTime() > RETRY_THROTTLE_MS
  );
}

/**
 * Milliseconds until the earliest row leaves the throttle window, or null when one already has.
 *
 * Needed because the throttle is a comparison against Date.now() evaluated during render: without a
 * scheduled re-render, an instructor who leaves the page open after a retry sees the button disabled
 * indefinitely, and the moment they can act again never arrives on screen.
 */
export function msUntilRetryable(rows: DiscordMembershipRow[], now: number = Date.now()): number | null {
  if (rows.length === 0 || canRetryAny(rows, now)) return null;
  const waits = rows.map((row) => new Date(row.last_retry_requested_at!).getTime() + RETRY_THROTTLE_MS - now);
  return Math.max(0, Math.min(...waits));
}

/**
 * Re-queue the Discord membership check for a group of students.
 *
 * This is the way out of a recorded `cannot_invite`. The status table exists so a failure that cannot
 * be retried automatically is recorded instead of looped, but that leaves an instructor who has just
 * fixed the bot's permissions with no way to say "try again now" -- and for a class past its end date
 * the hourly sync will never say it for them.
 *
 * Queues work rather than doing it: the worker re-runs the membership check, mints a fresh invite if
 * one is needed, and records the outcome, so a student who has since joined comes back as in_guild and
 * drops off the alert by itself.
 */
export default function DiscordReinviteButton({
  classId,
  rows,
  userId,
  label,
  onQueued
}: {
  classId: number;
  /** The rows this button covers, used only to decide whether the throttle has expired. */
  rows: DiscordMembershipRow[];
  /** Retry one user. Omitted, the RPC retries everyone in the class not recorded as in_guild. */
  userId?: string;
  label: string;
  onQueued?: () => void;
}) {
  const [running, setRunning] = useState(false);
  // Bumped by the timer below purely to force a re-evaluation of the throttle.
  const [, setTick] = useState(0);
  const throttled = !canRetryAny(rows);

  useEffect(() => {
    const wait = msUntilRetryable(rows);
    if (wait === null) return;
    const timer = setTimeout(() => setTick((t) => t + 1), wait + 1000);
    return () => clearTimeout(timer);
  }, [rows]);

  const run = async () => {
    setRunning(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("request_discord_reinvite", {
        p_class_id: classId,
        p_user_id: userId ?? undefined
      });

      if (error) {
        toaster.create({ title: "Could not queue the retry", description: error.message, type: "error" });
        return;
      }

      // RETURNS TABLE, so PostgREST sends a one-row array.
      const queued = data?.[0]?.queued ?? 0;
      const rolesRepaired = data?.[0]?.roles_repaired ?? 0;

      if (rolesRepaired > 0) {
        // The class was missing the Discord roles the sync assigns, which is the state a class is
        // left in when its role creation failed. Nothing could have been queued for those students
        // until the roles exist, so this is reported as its own outcome rather than folded into a
        // count of zero that would look like nothing was wrong.
        toaster.create({
          title: "Re-creating this course's Discord roles",
          description:
            queued > 0
              ? `${queued} queued. The rest are waiting on ${rolesRepaired} missing ${rolesRepaired === 1 ? "role" : "roles"} — retry in a minute once those exist.`
              : `${rolesRepaired} missing ${rolesRepaired === 1 ? "role was" : "roles were"} never created. Retry in a minute once they exist.`,
          type: "warning"
        });
      } else if (queued === 0) {
        // Not an error: everyone covered was either already in the server or inside the throttle
        // window. Saying so beats a success toast that claims work nobody will see happen.
        toaster.create({
          title: "Nothing to retry",
          description: "These students were either already in the server or retried in the last few minutes.",
          type: "info"
        });
      } else {
        toaster.create({
          title: `Queued ${queued} ${queued === 1 ? "student" : "students"}`,
          description: "Discord sync runs about once a minute. Reload to see the result.",
          type: "success"
        });
      }
      onQueued?.();
    } finally {
      setRunning(false);
    }
  };

  return (
    <Button
      size="xs"
      variant="outline"
      mt={2}
      loading={running}
      disabled={throttled}
      onClick={run}
      title={throttled ? "Already retried in the last few minutes" : undefined}
    >
      {label}
    </Button>
  );
}
