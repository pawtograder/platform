import { useUserProfile } from "@/hooks/useUserProfiles";
import { HStack, Avatar, Text, VStack } from "@chakra-ui/react";

export default function PersonName({ uid, size = "sm" }: { uid: string, size?: "2xs"| "xs" | "sm" | "md" | "lg" }) {
    const userProfile = useUserProfile(uid);
    return  <Avatar.Root size={size}>
            <Avatar.Image src={userProfile?.avatar_url} />
            <Avatar.Fallback>{userProfile?.name?.charAt(0)}</Avatar.Fallback>
        </Avatar.Root>
}