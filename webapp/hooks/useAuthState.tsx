'use client'
import { UserProfile, UserRole } from "@/utils/supabase/DatabaseTypes"
import { User } from "@supabase/supabase-js"
import { createContext, useContext } from "react"
type AuthStateContextType = {
    user: User | null
    isInstructor: boolean
    public_profile_id: string | null
    private_profile_id: string | null
    roles: UserRole[]
}
const AuthStateContext = createContext<AuthStateContextType>({ user: null, isInstructor: false, roles: [], public_profile_id: null, private_profile_id: null })
export function AuthStateProvider({ children, user, isInstructor, roles, public_profile_id, private_profile_id }: { children: React.ReactNode, user: User | null, isInstructor: boolean, roles: UserRole[], public_profile_id: string, private_profile_id: string }) {
    return (
        <AuthStateContext.Provider value={{ user, isInstructor, roles, public_profile_id, private_profile_id }}>
            {children}
        </AuthStateContext.Provider>
    )
}
export default function useAuthState() {
    const state = useContext(AuthStateContext)
    return state
}
