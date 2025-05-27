import { useUserProfile } from "@/hooks/useUserProfiles";
import { HStack, Avatar, Text, VStack, type TextProps } from "@chakra-ui/react";

export default function PersonName({
  uid,
  size = "sm",
  showAvatar = true,
  textProps
}: {
  uid: string;
  size?: "2xs" | "xs" | "sm" | "md" | "lg";
  showAvatar?: boolean;
  textProps?: TextProps;
}) {
  const userProfile = useUserProfile(uid);
  return (
    <HStack>
      {showAvatar && (
        <Avatar.Root size={size}>
          <Avatar.Image src={userProfile?.avatar_url} />
          <Avatar.Fallback>{userProfile?.name?.charAt(0)}</Avatar.Fallback>
        </Avatar.Root>
      )}
      <VStack>
        <Text {...textProps}>{userProfile?.name}</Text>
      </VStack>
    </HStack>
  );
}
