"use client";

import { linkDiscordAction } from "@/app/actions";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useIdentity } from "@/hooks/useIdentities";
import { Button, Heading, HStack, Icon, Text, VStack } from "@chakra-ui/react";
import { useSearchParams } from "next/navigation";
import { BsDiscord, BsInfoCircle } from "react-icons/bs";
import { Alert } from "../ui/alert";
import { PopoverBody, PopoverContent, PopoverHeader, PopoverRoot, PopoverTrigger } from "../ui/popover";

function HelpDialog() {
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <Button colorPalette="blue" variant="subtle">
          <BsInfoCircle />
          <Text fontSize="sm">More info</Text>
        </Button>
      </PopoverTrigger>
      <PopoverContent width="lg">
        <PopoverHeader>
          <Heading size="sm">FAQs about Discord and Pawtograder</Heading>
        </PopoverHeader>
        <PopoverBody>
          <Text>This feature is currently available for staff members (instructors and graders) only.</Text>
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
}

export default function LinkDiscordAccount() {
  const { identities } = useIdentity();
  const searchParams = useSearchParams();
  const errorDescription = searchParams.get("error_description");
  const isStaff = useIsGraderOrInstructor();
  const discordIdentity = identities?.find((identity) => identity.provider === "discord");

  // Only show for staff members
  if (!isStaff) {
    return null;
  }

  const handleLinkDiscord = async () => {
    await linkDiscordAction();
  };

  return (
    <VStack gap={3} width="100%">
      {/* Link Discord Account Card - only show if not linked */}
      {(!identities || !discordIdentity) && (
        <VStack
          borderWidth="1px"
          p="4"
          borderColor="border.info"
          borderRadius="md"
          width="100%"
          mt="0"
          mb="5"
          bg="bg.info"
          mx="auto"
          alignItems="flex-start"
          gap={3}
        >
          {errorDescription && (
            <Alert status="error" title="Discord Connection Error" mb="4">
              {errorDescription}
            </Alert>
          )}
          <HStack alignItems="flex-start" width="100%" justifyContent="space-between">
            <VStack alignItems="flex-start" gap={1}>
              <HStack>
                <Icon size="xl" as={BsDiscord} />
                <Heading size="lg">Connect to Discord</Heading>
              </HStack>
              <Text fontSize="sm">
                Link your Discord account to receive notifications about help requests and regrade requests in your
                classes.
              </Text>
              <Text fontSize="sm">This feature is available for staff members only.</Text>
            </VStack>
            <HStack gap={2}>
              <HelpDialog />
              <Button colorPalette="blue" onClick={handleLinkDiscord}>
                <BsDiscord /> Connect Discord
              </Button>
            </HStack>
          </HStack>
        </VStack>
      )}
    </VStack>
  );
}
