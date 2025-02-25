'use client'
import { User } from "@supabase/supabase-js"
import { createContext, useContext, useEffect, useState } from "react"
import { PublicProfile } from "@/utils/supabase/DatabaseTypes"
import { createClient } from "@/utils/supabase/client"
type AuthStateContextType = {
    user: User | null
    isInstructor: boolean
}
const AuthStateContext = createContext<AuthStateContextType>({ user: null, isInstructor: false })
export function AuthStateProvider({ children, user, isInstructor }: { children: React.ReactNode, user: User | null, isInstructor: boolean }) {
    return (
        <AuthStateContext.Provider value={{ user, isInstructor }}>
            {children}
        </AuthStateContext.Provider>
    )
}
export default function useAuthState() {
    const state = useContext(AuthStateContext)
    return state
}
