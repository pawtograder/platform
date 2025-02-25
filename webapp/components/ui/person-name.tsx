import { useUserProfile } from "@/hooks/useUserProfiles";
import { HStack, Avatar, Text, VStack } from "@chakra-ui/react";

export default function PersonName({ uid }: { uid: string }) {
    const userProfile = useUserProfile(uid);
    return <HStack>
        <Avatar.Root>
            <Avatar.Image src={userProfile?.avatar_url} />
            <Avatar.Fallback>{userProfile?.name?.charAt(0)}</Avatar.Fallback>
        </Avatar.Root>
        <VStack>
            <Text>{userProfile?.name}</Text>
        </VStack>
    </HStack>
}