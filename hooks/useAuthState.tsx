'use client'
import { UserProfile, UserRole, UserRoleWithCourse } from "@/utils/supabase/DatabaseTypes"
import { User } from "@supabase/supabase-js"
import { createContext, useContext } from "react"
type AuthStateContextType = {
    user: User | null
    roles: UserRoleWithCourse[]
}
const AuthStateContext = createContext<AuthStateContextType>({ user: null, roles: [] })
export function AuthStateProvider({ children, user, roles}: { children: React.ReactNode, user: User | null, roles: UserRoleWithCourse[] }) {
    return (
        <AuthStateContext.Provider value={{ user, roles }}>
            {children}
        </AuthStateContext.Provider>
    )
}
export default function useAuthState() {
    const state = useContext(AuthStateContext)
    return state
}
