'use client'

import { Flex, HStack, IconButton, Link, MenuContent, MenuItem, MenuRoot, MenuTrigger, Text, VStack } from "@chakra-ui/react";
import { signOutAction } from "../actions";
import { Skeleton, SkeletonCircle } from "@/components/ui/skeleton"

import { Box } from "lucide-react";
import { FiBell, FiChevronDown } from "react-icons/fi";
import { useEffect, useState } from "react";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { User } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/client";
import { Avatar, AvatarGroup } from "@/components/ui/avatar"
export default function UserMenu() {
    const [profile, setProfile] = useState<Database['public']['Tables']['profiles']['Row'] | undefined>()
    const [user, setUser] = useState<User | null>(null)

    useEffect(() => {
        // Fetch profile
        const supabase = createClient();
        const fetchUser = async () => {
            const { data, error } = await supabase.auth.getUser();
            if (error) {
                console.error(error)
            }
            const uid = data!.user!.id;
            const fetchProfile = async () => {
                const { data, error } = await supabase.from('profiles').select('*').
                    eq('id', uid).single();
                if (error) {
                    console.error(error)
                }
                if (data)
                    setProfile(data)
            }
            fetchProfile()
            setUser(data.user)
        };
        fetchUser();
    }
        , [])

    return (
        <HStack>
            {profile && profile.avatar_url ? <Avatar
                size={'sm'}
                src={
                    profile.avatar_url
                }
            /> : <SkeletonCircle size="8" />}
            <VStack
                display={{ base: 'none', md: 'flex' }}
                alignItems="flex-start"
                gap="0"
                ml="2">
                {profile ? <Text fontSize="sm" color="black">{profile.name}</Text> : <Skeleton />}
                <Link fontSize="sm" onClick={signOutAction}>Sign out</Link>
            </VStack>
        </HStack>

    );
}