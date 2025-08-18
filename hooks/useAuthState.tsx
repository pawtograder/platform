"use client";
import { User } from "@supabase/supabase-js";
import { createContext, useContext } from "react";
type AuthStateContextType = {
  user: User | null;
};
const AuthStateContext = createContext<AuthStateContextType>({ user: null });
export function AuthStateProvider({ children, user }: { children: React.ReactNode; user: User | null }) {
  return <AuthStateContext.Provider value={{ user }}>{children}</AuthStateContext.Provider>;
}
export default function useAuthState() {
  const state = useContext(AuthStateContext);
  return state;
}
