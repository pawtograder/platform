'use client'

import { Flex, HStack, IconButton, Link, MenuContent, MenuItem, MenuRoot, MenuTrigger, Text, VStack, Badge, Drawer, Portal, CloseButton, Button } from "@chakra-ui/react";
import { signOutAction } from "../actions";
import { Skeleton, SkeletonCircle } from "@/components/ui/skeleton"
import { PiSignOut } from "react-icons/pi";

import { Box } from "lucide-react";
import { FiBell, FiChevronDown } from "react-icons/fi";
import { useEffect, useState } from "react";
import { UserProfile } from "@/utils/supabase/DatabaseTypes";
import { User } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/client";
import { Avatar, AvatarGroup } from "@/components/ui/avatar"
import { ColorModeButton } from "@/components/ui/color-mode";
import { useParams } from "next/navigation";
import NotificationsBox from "@/components/ui/notifications/notifications-box";
import useAuthState from "@/hooks/useAuthState";
import { useUserProfile } from "@/hooks/useUserProfiles";

function UserSettingsMenu() {
    const [open, setOpen] = useState(false)
    const supabase = createClient();
    const { user } = useAuthState();
    const { course_id } = useParams();
    const [profile, setProfile] = useState<UserProfile | null>(null);
    useEffect(() => {
        // Fetch profile
        const fetchProfile = async () => {
            if (course_id) {
                const { data, error } = await supabase.from('user_roles').select('profiles!private_profile_id(*)').
                    eq('user_id', user!.id).eq('class_id', Number(course_id)).single();
                if (error) {
                    console.error(error)
                }
                if (data)
                    setProfile(data.profiles!)
            } else {
                const { data, error } = await supabase.from('user_roles').select('profiles!private_profile_id(*)').
                    eq('user_id', user!.id).limit(1).single();
                if (error) {
                    console.error(error)
                }
                if (data)
                    setProfile(data.profiles!)
            }
        };
        fetchProfile()
    }, [course_id, user])


    return (
        <Drawer.Root open={open} onOpenChange={(e) => setOpen(e.open)}>
            <Drawer.Trigger>
                {profile && profile.avatar_url ? <Avatar
                    size={'sm'}
                    src={
                        profile.avatar_url
                    }
                /> : <SkeletonCircle size="8" />}
            </Drawer.Trigger>
            <Portal>
                <Drawer.Backdrop />
                <Drawer.Positioner>

                    <Drawer.Content pt={2} pl={2} borderTopLeftRadius="md" borderWidth={1} borderColor="border.emphasized">
                        <Drawer.CloseTrigger asChild>
                            <CloseButton size="sm" position="absolute" right={4} top={4} />
                        </Drawer.CloseTrigger>
                        <Drawer.Body p={2}>
                            <VStack alignItems="flex-start">
                                <HStack>
                                    <Avatar src={profile?.avatar_url || undefined} size="sm" />
                                    <VStack alignItems="flex-start">
                                        <Text fontWeight="bold">{profile?.name}</Text>
                                    </VStack>
                                </HStack>
                                <Button variant="ghost"
                                    pl={0}
                                    onClick={signOutAction}
                                    width="100%" textAlign="left" justifyContent="flex-start">
                                    <PiSignOut />
                                    Sign out
                                </Button>
                            </VStack>
                        </Drawer.Body>

                    </Drawer.Content>
                </Drawer.Positioner>
            </Portal>
        </Drawer.Root>
    )
}
export default function UserMenu() {

    const { course_id } = useParams();

    return (
        <HStack>
            <ColorModeButton colorPalette="gray" variant="outline" />

            <NotificationsBox />
            <UserSettingsMenu />
        </HStack>

    );
}