"use client";

import { createClient } from "@/utils/supabase/client";
import { useEffect, useMemo, useRef, useState } from "react";

const PAGE_SIZE = 1000;
/** Accounts are created a few seconds after enrollment, so an open roster checks again on this interval. */
const REFRESH_MS = 30_000;

export type ForgejoLogins = {
  /** Forgejo login by Pawtograder user id. A user missing here has no account yet (#1092). */
  byUserId: Map<string, string>;
  loading: boolean;
  error: string | null;
};

/**
 * Forgejo usernames for the roster. RLS limits staff to people in their own classes, so one query
 * covers the class without filtering by it here. While the tab is visible it looks again every
 * REFRESH_MS, so an account created after the roster opened shows up without a reload. Only the first
 * load shows as loading or failed; a refresh that fails keeps the last list.
 */
export function useForgejoLogins(enabled: boolean): ForgejoLogins {
  const [byUserId, setByUserId] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  // Until a lookup finishes, every attempt is the first load: a slow first lookup that a refresh
  // cancels must not leave the roster on "Loading…".
  const loaded = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setRefresh((n) => n + 1);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      // The same empty map, so a roster without the feature doesn't rebuild its rows on mount.
      setByUserId((previous) => (previous.size === 0 ? previous : new Map()));
      setError(null);
      setLoading(false);
      loaded.current = false;
      return;
    }
    let cancelled = false;
    const firstLoad = !loaded.current;
    if (firstLoad) setLoading(true);
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
        loaded.current = true;
        setError(null);
        // A new Map only when something changed: the roster rebuilds its rows when this changes.
        setByUserId((previous) => (sameLogins(previous, logins) ? previous : logins));
      })
      .catch((queryError: { message?: string }) => {
        if (cancelled || !firstLoad) return;
        loaded.current = true;
        setError(queryError?.message ?? "Failed to load Forgejo usernames");
      })
      .finally(() => {
        if (!cancelled && firstLoad) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, refresh]);

  // One object until something changes: the roster lists it as a dependency of its columns and rows.
  return useMemo(() => ({ byUserId, loading, error }), [byUserId, loading, error]);
}

function sameLogins(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [userId, login] of a) if (b.get(userId) !== login) return false;
  return true;
}
