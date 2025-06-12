import { createClient } from "@/utils/supabase/client";
import { UserIdentity } from "@supabase/supabase-js";
import { useEffect, useState } from "react";

interface UseIdentityReturn {
  identities: UserIdentity[] | null;
  loading: boolean;
  error: string | null;
}

export function useIdentity(): UseIdentityReturn {
  const [identities, setIdentities] = useState<UserIdentity[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const supabase = createClient();
  useEffect(() => {
    const fetchIdentities = async () => {
      try {
        setLoading(true);
        setError(null);

        const identitiesResponse = await supabase.auth.getUserIdentities();
        const userIdentities = identitiesResponse.data?.identities || [];
        setIdentities(userIdentities);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch identities");
      } finally {
        setLoading(false);
      }
    };

    fetchIdentities();
  }, [supabase]);

  return {
    identities,
    loading,
    error
  };
}
