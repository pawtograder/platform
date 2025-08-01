"use client";

import { useClassProfiles } from "@/hooks/useClassProfiles";
import { createClient } from "@/utils/supabase/client";
import { Box, Button, Heading, VStack } from "@chakra-ui/react";
import { toaster, Toaster } from "../ui/toaster";
import { Alert } from "../ui/alert";
import { EdgeFunctionError, resendOrgInvitation } from "@/lib/edgeFunctions";
import { FaEnvelope } from "react-icons/fa";
const MAXIMUM_INVITE_FREQUENCY_MS = 1000 * 60 * 60 * 24 * 5; // 5 days
export default function ResendOrgInvitation() {
  const { role } = useClassProfiles();
  if (role.github_org_confirmed || !role.users.github_username) {
    return null;
  }
  const lastInviteTime = role.invitation_date;
  const canResendInvite =
    !lastInviteTime || Date.now() - new Date(lastInviteTime).getTime() > MAXIMUM_INVITE_FREQUENCY_MS;
  const supabase = createClient();

  return (
    <Alert width="xl" mt="5" mb="5" mx="auto" status="info">
      <Toaster />
      <VStack>
        <Heading size="md">You must join the course organization on GitHub</Heading>
        <Box>
          Your Pawtograder account is linked to the GitHub account {role.users.github_username}, but you have not yet
          joined the course organization. This invitation was sent{" "}
          {lastInviteTime
            ? `on ${new Date(lastInviteTime).toLocaleDateString()} at ${new Date(lastInviteTime).toLocaleTimeString()}`
            : "recently"}{" "}
          to the email address associated with this GitHub account.
        </Box>
        <Button
          size="lg"
          colorPalette="blue"
          onClick={() => window.open(`https://github.com/orgs/${role.classes.github_org}/invitation`, "_blank")}
        >
          Open GitHub Organization Invitation
        </Button>
        <Box>
          After accepting the invitation, you should be able to refresh this page and this message will disappear.
        </Box>
        {!canResendInvite && (
          <Box fontSize="sm">
            You can not resend the invitation because it was sent less than 5 days ago. If you declined the invitation
            and need it to be resent, please contact your instructor.
          </Box>
        )}
        {canResendInvite && (
          <>
            <Box fontSize="sm">If you receive an error that the invitation has expired, you can resend it below.</Box>
            <Button
              size="sm"
              variant="subtle"
              colorPalette="blue"
              onClick={async () => {
                try {
                  await resendOrgInvitation({ course_id: role.class_id, user_id: role.users.user_id }, supabase);
                  toaster.success({
                    title: "Invitation resent",
                    description: "You should receive an email from GitHub shortly."
                  });
                } catch (error) {
                  if (error instanceof EdgeFunctionError) {
                    toaster.error({ title: "Error", description: error.message + " " + error.details });
                  } else {
                    toaster.error({
                      title: "Error",
                      description:
                        "Failed to resend invitation. Error: " +
                        (error instanceof Error ? error.message : "Unknown error")
                    });
                  }
                }
              }}
            >
              <FaEnvelope /> Resend invitation
            </Button>
          </>
        )}
      </VStack>
    </Alert>
  );
}
