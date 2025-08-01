"use client";
import type { UserRoleWithCourseAndUser } from "@/utils/supabase/DatabaseTypes";
import type { User } from "@supabase/supabase-js";
import { useParams } from "next/navigation";
import { createContext, useContext } from "react";
type AuthStateContextType = {
  user: User | null;
  roles: UserRoleWithCourseAndUser[];
};
const AuthStateContext = createContext<AuthStateContextType>({ user: null, roles: [] });
export function AuthStateProvider({
  children,
  user,
  roles
}: {
  children: React.ReactNode;
  user: User | null;
  roles: UserRoleWithCourseAndUser[];
}) {
  return <AuthStateContext.Provider value={{ user, roles }}>{children}</AuthStateContext.Provider>;
}
export default function useAuthState() {
  const state = useContext(AuthStateContext);
  return state;
}
export function useCourse() {
  const { course_id } = useParams();
  const { roles } = useAuthState();
  const course = roles.find((role) => role.class_id === Number.parseInt(course_id as string));
  return course!;
}
