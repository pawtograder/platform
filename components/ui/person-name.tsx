import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { Avatar, HStack, Text, TextProps, VStack } from "@chakra-ui/react";
import { memo } from "react";

const MemoizedPersonName = memo(PersonName);
export default MemoizedPersonName;

function PersonName({
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
  const isStaff = useIsGraderOrInstructor();

  // Show the real name in parentheses if the profile is a pseudonym and viewer is staff
  const displayName = userProfile?.name || "";
  const realNameSuffix = isStaff && userProfile?.real_name ? ` (${userProfile.real_name})` : "";

  if (!showAvatar) {
    return (
      <>
        {displayName}
        {realNameSuffix}
      </>
    );
  }
  return (
    <HStack w="100%">
      <Avatar.Root size={size}>
        <Avatar.Image src={userProfile?.avatar_url} />
        <Avatar.Fallback>{userProfile?.name?.charAt(0)}</Avatar.Fallback>
      </Avatar.Root>
      <VStack>
        <Text {...textProps}>
          {displayName}
          {realNameSuffix && (
            <Text as="span" color="fg.muted" fontSize="xs">
              {realNameSuffix}
            </Text>
          )}
        </Text>
      </VStack>
    </HStack>
  );
}
