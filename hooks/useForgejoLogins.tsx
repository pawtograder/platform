"use client";

import { createClient } from "@/utils/supabase/client";
import { useEffect, useState } from "react";

const PAGE_SIZE = 1000;

export type ForgejoLogins = {
  /** Forgejo login by Pawtograder user id. A user missing here has no account yet (#1092). */
  byUserId: Map<string, string>;
  loading: boolean;
  error: string | null;
};

/**
 * Forgejo usernames for the roster. RLS limits staff to people in their own classes, so one query
 * covers the class without filtering by it here.
 */
export function useForgejoLogins(enabled: boolean): ForgejoLogins {
  const [byUserId, setByUserId] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setByUserId(new Map());
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const client = createClient();
      const logins = new Map<string, string>();
      // PostgREST caps a response at 1,000 rows, and staff see every class they teach. Oldest first,
      // so a user's newest account, the current instance after a FORGEJO_URL change, is the one kept.
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error: queryError } = await client
          .from("git_accounts")
          .select("user_id, login")
          .eq("provider", "forgejo")
          .not("login", "is", null)
          .order("created_at")
          .order("id")
          .range(from, from + PAGE_SIZE - 1);
        if (queryError) throw queryError;
        for (const row of data ?? []) logins.set(row.user_id, String(row.login));
        if ((data ?? []).length < PAGE_SIZE) return logins;
      }
    })()
      .then((logins) => {
        if (cancelled) return;
        setError(null);
        setByUserId(logins);
      })
      .catch((queryError: { message?: string }) => {
        if (cancelled) return;
        setError(queryError?.message ?? "Failed to load Forgejo usernames");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { byUserId, loading, error };
}
