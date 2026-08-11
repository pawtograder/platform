"use client";

import { createClient } from "@/utils/supabase/client";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { useCallback, useEffect, useMemo, useState } from "react";

export type DiscordMembershipState = Database["public"]["Enums"]["discord_membership_state"];

export type DiscordMembershipRow =
  Database["public"]["Functions"]["get_discord_membership_status_for_class"]["Returns"][number];

export type DiscordMembershipStatus = {
  /** Students who have not joined the class's Discord server. Normal, and resolves when they join. */
  notJoined: DiscordMembershipRow[];
  /** Students the bot cannot even invite. Needs a Discord admin, so it is surfaced as an error. */
  cannotInvite: DiscordMembershipRow[];
  /**
   * Every state that has been recorded, by user id. A user missing from this map has not been checked
   * yet, which is not the same as being in the server — the roster has to say so rather than guess.
   */
  byUserId: Map<string, DiscordMembershipState>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

/**
 * Who is missing from a class's Discord server, and why.
 *
 * Both states used to be invisible: the role sync retried them hourly and dead-lettered them, so the
 * only trace was 30,332 queue rows nobody was watching. The two causes are kept apart because they
 * need different people to act — a student who has not joined resolves itself, a bot that cannot
 * invite does not.
 */
export function useDiscordMembershipStatus(classId: number | undefined): DiscordMembershipStatus {
  const [rows, setRows] = useState<DiscordMembershipRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    if (classId === undefined) {
      setRows([]);
      return;
    }

    let cancelled = false;
    const supabase = createClient();

    setLoading(true);
    supabase
      .rpc("get_discord_membership_status_for_class", { p_class_id: classId })
      .then(({ data, error: rpcError }) => {
        if (cancelled) return;
        if (rpcError) {
          setError(rpcError.message);
          setRows([]);
        } else {
          setError(null);
          setRows(data ?? []);
        }
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [classId, reloadToken]);

  return useMemo(
    () => ({
      notJoined: rows.filter((row) => row.state === "not_joined"),
      cannotInvite: rows.filter((row) => row.state === "cannot_invite"),
      byUserId: new Map(rows.map((row) => [row.user_id, row.state])),
      loading,
      error,
      refresh
    }),
    [rows, loading, error, refresh]
  );
}
