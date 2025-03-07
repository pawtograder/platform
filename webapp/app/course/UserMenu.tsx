'use client'

import { Flex, HStack, IconButton, Link, MenuContent, MenuItem, MenuRoot, MenuTrigger, Text, VStack } from "@chakra-ui/react";
import { signOutAction } from "../actions";
import { Skeleton, SkeletonCircle } from "@/components/ui/skeleton"

import { Box } from "lucide-react";
import { FiBell, FiChevronDown } from "react-icons/fi";
import { useEffect, useState } from "react";
import { UserProfile } from "@/utils/supabase/DatabaseTypes";
import { User } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/client";
import { Avatar, AvatarGroup } from "@/components/ui/avatar"
import { ColorModeButton } from "@/components/ui/color-mode";
import { useParams } from "next/navigation";
export default function UserMenu() {
    const [profile, setProfile] = useState<UserProfile | undefined>()
    const [user, setUser] = useState<User | null>(null)
    const { course_id } = useParams();
    const supabase = createClient();

    useEffect(() => {
        // Fetch profile
        const fetchUser = async () => {
            const { data, error } = await supabase.auth.getUser();
            if (error) {
                console.error(error)
            }
            const uid = data!.user!.id;
            const fetchProfile = async () => {
                if (course_id) {
                    const { data, error } = await supabase.from('user_roles').select('profiles!private_profile_id(*)').
                        eq('user_id', uid).eq('class_id', Number(course_id)).single();
                    if (error) {
                        console.error(error)
                    }
                    if (data)
                        setProfile(data.profiles!)
                } else {
                    const { data, error } = await supabase.from('user_roles').select('profiles!private_profile_id(*)').
                        eq('user_id', uid).limit(1).single();
                    if (error) {
                        console.error(error)
                    }
                    if (data)
                        setProfile(data.profiles!)
                }
                setUser(data.user)
            };
            fetchProfile()
        }
        fetchUser();
    }, [course_id])

    return (
        <HStack>
            <ColorModeButton />

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
                {profile ? <Text fontSize="sm">{profile.name}</Text> : <Skeleton />}
                <Link fontSize="sm" onClick={signOutAction}>Sign out</Link>
            </VStack>
        </HStack>

    );
}