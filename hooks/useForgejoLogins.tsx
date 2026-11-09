"use client";

import { createClient } from "@/utils/supabase/client";
import { useEffect, useState } from "react";

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
    createClient()
      .from("git_accounts")
      .select("user_id, login")
      .eq("provider", "forgejo")
      .not("login", "is", null)
      .then(({ data, error: queryError }) => {
        if (cancelled) return;
        setError(queryError?.message ?? null);
        setByUserId(new Map((data ?? []).map((row) => [row.user_id, String(row.login)])));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { byUserId, loading, error };
}
