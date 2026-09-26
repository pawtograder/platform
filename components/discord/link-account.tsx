"use client";

import { linkDiscordAction } from "@/app/actions";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useCourse } from "@/hooks/useCourseController";
import { useIdentity } from "@/hooks/useIdentities";
import { COURSE_FEATURES, courseFeatureEnabled } from "@/lib/courseFeatures";
import type { CourseWithFeatures } from "@/utils/supabase/DatabaseTypes";
import { Button, Heading, HStack, Icon, Text, VStack } from "@chakra-ui/react";
import { useSearchParams } from "next/navigation";
import { BsDiscord, BsInfoCircle } from "react-icons/bs";
import { Alert } from "../ui/alert";
import { PopoverBody, PopoverContent, PopoverHeader, PopoverRoot, PopoverTrigger } from "../ui/popover";

function HelpDialog({ forStudent }: { forStudent: boolean }) {
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
          {forStudent ? (
            <Text>
              Linking your Discord account lets this course invite you to its Discord server and give you the right
              roles there. Pawtograder never posts as you, and never sees your messages or your other servers. Unlinking
              stops both.
            </Text>
          ) : (
            <Text>
              Linking your Discord account lets Pawtograder notify you about help requests and regrade requests in your
              courses, and lets it give you your staff roles in each course&apos;s Discord server.
            </Text>
          )}
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
}

/**
 * Offer to link a Discord account, to whoever is actually allowed to have one linked.
 *
 * Staff always see it: their Discord link drives help-request and regrade notifications and their
 * staff roles in every course server.
 *
 * Students see it when their course has opted in with the "Let students join this course's Discord
 * server" feature flag AND a server is configured -- the same pair of conditions that gates the
 * invitation panel on their dashboard. It used to be staff-only, unconditionally, which quietly broke
 * the whole student join flow: every step that mints a student invite requires `users.discord_id`, and
 * `linkDiscordAction` is the only thing that sets it, so a course could turn the flag on and no
 * student could ever act on it. The flag's own description ("the sync creates one for any student who
 * has linked a Discord account") assumes this control exists.
 *
 * The feature gate is checked here rather than left to the caller so the component is safe to mount
 * anywhere; the previous arrangement put the policy in the mount site and then mounted it in exactly
 * one staff-only place, which is how the gap went unnoticed.
 */
export default function LinkDiscordAccount() {
  const { identities } = useIdentity();
  const searchParams = useSearchParams();
  const errorDescription = searchParams.get("error_description");
  const isStaff = useIsGraderOrInstructor();
  // Cast as membership-status-alerts does: classes.features is jsonb, and courseFeatureEnabled treats
  // anything that is not an array of entries as "no entries".
  const course = useCourse() as CourseWithFeatures;
  const discordIdentity = identities?.find((identity) => identity.provider === "discord");

  const studentsMayJoin =
    Boolean(course?.discord_server_id) && courseFeatureEnabled(course?.features, COURSE_FEATURES.DISCORD_STUDENT_JOIN);
  if (!isStaff && !studentsMayJoin) {
    return null;
  }
  // Nothing until the identities are known, and nothing once Discord is among them. Previously the
  // card rendered while `identities` was still null and the wrapper rendered empty once linked, which
  // was invisible enough on a staff settings page someone had navigated to on purpose. On a student
  // dashboard it is a "Connect Discord" card that appears on every load and then vanishes.
  if (!identities || discordIdentity) {
    return null;
  }
  const forStudent = !isStaff;

  const handleLinkDiscord = async () => {
    await linkDiscordAction();
  };

  return (
    <VStack gap={3} width="100%">
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
              {forStudent
                ? "Link your Discord account to get your invitation to this course's Discord server, and to be given the right roles once you are in it."
                : "Link your Discord account to receive notifications about help requests and regrade requests in your classes."}
            </Text>
          </VStack>
          <HStack gap={2}>
            <HelpDialog forStudent={forStudent} />
            <Button colorPalette="blue" onClick={handleLinkDiscord}>
              <BsDiscord /> Connect Discord
            </Button>
          </HStack>
        </HStack>
      </VStack>
    </VStack>
  );
}
