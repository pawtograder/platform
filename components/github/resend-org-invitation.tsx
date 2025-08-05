"use client";

import { useClassProfiles } from "@/hooks/useClassProfiles";
import { createClient } from "@/utils/supabase/client";
import { Box, Button, Heading, HStack, Icon, Text, VStack, PopoverTrigger } from "@chakra-ui/react";
import { toaster, Toaster } from "../ui/toaster";
import { EdgeFunctionError, resendOrgInvitation } from "@/lib/edgeFunctions";
import { FaEnvelope } from "react-icons/fa";
import { BsGithub, BsInfoCircle } from "react-icons/bs";
import { PopoverBody, PopoverContent, PopoverHeader, PopoverRoot } from "../ui/popover";
import { useState } from "react";

const MAXIMUM_INVITE_FREQUENCY_MS = 1000 * 60 * 60 * 24 * 5; // 5 days

function HelpDialog() {
  const { role } = useClassProfiles();
  const lastInviteTime = role.invitation_date;
  const canResendInvite =
    !lastInviteTime || Date.now() - new Date(lastInviteTime).getTime() > MAXIMUM_INVITE_FREQUENCY_MS;

  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <Button colorPalette="green" variant="subtle">
          <BsInfoCircle />
          <Text fontSize="sm">Help</Text>
        </Button>
      </PopoverTrigger>
      <PopoverContent width="lg">
        <PopoverHeader>
          <Heading size="sm">GitHub Organization Invitation Help</Heading>
        </PopoverHeader>
        <PopoverBody>
          <VStack alignItems="flex-start" gap="3">
            <Box>
              Your Pawtograder account is linked to the GitHub account{" "}
              <Text as="span" fontWeight="bold" bg="bg.info" borderRadius="md" p="1">
                {role.users.github_username}
              </Text>
              , but you have not yet joined the course organization. This invitation was sent{" "}
              {lastInviteTime
                ? `on ${new Date(lastInviteTime).toLocaleDateString()} at ${new Date(lastInviteTime).toLocaleTimeString()}`
                : "recently"}{" "}
              to the email address associated with this GitHub account.
            </Box>
            <Text>
              After accepting the invitation, you should be able to refresh this page and this message will disappear.
            </Text>
            {!canResendInvite && (
              <Text fontSize="sm">
                You cannot resend the invitation because it was sent less than 5 days ago. If you declined the
                invitation and need it to be resent, please contact your instructor.
              </Text>
            )}
            {canResendInvite && (
              <Text fontSize="sm">
                If you receive an error that the invitation has expired, you can resend it using the button below.
              </Text>
            )}
          </VStack>
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
}

export default function ResendOrgInvitation() {
  const { role } = useClassProfiles();

  const [isResending, setIsResending] = useState(false);
  const [inviteSent, setInviteSent] = useState(false);

  const supabase = createClient();
  if (role.github_org_confirmed || !role.users.github_username) {
    return null;
  }
  const lastInviteTime = role.invitation_date;
  const canResendInvite =
    !lastInviteTime || Date.now() - new Date(lastInviteTime).getTime() > MAXIMUM_INVITE_FREQUENCY_MS;

  return (
    <Box
      borderWidth="1px"
      p="2"
      borderColor="border.success"
      borderRadius="md"
      width="100%"
      mt="0"
      mb="5"
      bg="bg.success"
      mx="auto"
    >
      <Toaster />
      <HStack alignItems="flex-start">
        <VStack alignItems="flex-start" gap="0">
          <HStack>
            <Icon size="xl" as={BsGithub} />
            <Heading size="lg">Join course GitHub organization to access assignments</Heading>
          </HStack>
          <Text fontSize="sm">
            Your Pawtograder account is linked to the GitHub account{" "}
            <Text as="span" fontWeight="bold" bg="bg.info" borderRadius="md">
              {role.users.github_username}
            </Text>
            , but you have not yet joined the course organization, so Pawtograder cannot create repositories for your
            assignments. This invitation was sent{" "}
            {lastInviteTime
              ? `on ${new Date(lastInviteTime).toLocaleDateString()} at ${new Date(lastInviteTime).toLocaleTimeString()}`
              : "recently"}{" "}
            to the email address associated with this GitHub account.
          </Text>
          <Text fontSize="sm">
            After accepting the invitation, you should be able to refresh this page and this message will disappear.
          </Text>
        </VStack>
        <VStack gap="2">
          <Button
            colorPalette="green"
            onClick={() => window.open(`https://github.com/orgs/${role.classes.github_org}/invitation`, "_blank")}
          >
            <FaEnvelope /> Open GitHub Organization Invitation
          </Button>
          <HStack>
            <HelpDialog />
            {canResendInvite && (
              <Button
                size="sm"
                variant="subtle"
                colorPalette="green"
                loading={isResending}
                disabled={inviteSent}
                onClick={async () => {
                  try {
                    setIsResending(true);
                    await resendOrgInvitation({ course_id: role.class_id, user_id: role.users.user_id }, supabase);
                    toaster.success({
                      title: "Invitation resent",
                      description: "You should receive an email from GitHub shortly."
                    });
                    setIsResending(false);
                    setInviteSent(true);
                  } catch (error) {
                    setIsResending(false);
                    if (error instanceof EdgeFunctionError) {
                      toaster.error({ title: "Error", description: error.message + " " + error.details });
                    } else {
                      toaster.error({ title: "Error", description: "Failed to resend invitation." });
                    }
                  }
                }}
              >
                <FaEnvelope /> Resend invitation
              </Button>
            )}
          </HStack>
        </VStack>
      </HStack>
    </Box>
  );
}
