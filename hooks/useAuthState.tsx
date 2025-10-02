"use client";
import { User } from "@supabase/supabase-js";
import { createContext, useContext, useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { usePostHog } from "posthog-js/react";
type AuthStateContextType = {
  user: User | null;
};
const AuthStateContext = createContext<AuthStateContextType>({ user: null });
export function AuthStateProvider({ children, user }: { children: React.ReactNode; user: User | null }) {
  const uid = user?.id;
  const posthog = usePostHog();
  useEffect(() => {
    if (uid) {
      Sentry.setUser({ id: uid });
      posthog.identify(uid);
    } else {
      Sentry.setUser(null);
      posthog.reset();
    }
  }, [uid, posthog]);
  return <AuthStateContext.Provider value={{ user }}>{children}</AuthStateContext.Provider>;
}
export default function useAuthState() {
  const state = useContext(AuthStateContext);
  return state;
}
