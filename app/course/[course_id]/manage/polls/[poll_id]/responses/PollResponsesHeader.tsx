"use client";

import { HStack, Button, Box, Text } from "@chakra-ui/react";
import { useParams, useRouter } from "next/navigation";
import { useColorModeValue } from "@/components/ui/color-mode";
import QrCode from "./QrCode";
import { useCourseController, useLivePoll } from "@/hooks/useCourseController";

type PollResponsesHeaderProps = {
  courseID: string;
  pollUrl: string;
  onPresent: () => void;
  qrCodeUrl?: string;
};

export default function PollResponsesHeader({ courseID, pollUrl, onPresent, qrCodeUrl }: PollResponsesHeaderProps) {
  const router = useRouter();
  const { poll_id } = useParams();
  const { livePolls } = useCourseController();
  const poll = useLivePoll(poll_id as string);

  const buttonTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const buttonBorderColor = useColorModeValue("#6B7280", "#4A5568");
  const textColor = useColorModeValue("#1A202C", "#FFFFFF");

  return (
    <Box p={4}>
      <HStack justify="space-between" align="center" gap={4}>
        <Button
          variant="outline"
          size="sm"
          bg="transparent"
          borderColor="border.emphasized"
          color="fg.muted"
          _hover={{ bg: "gray.subtle" }}
          onClick={() => router.push(`/course/${courseID}/manage/polls`)}
        >
          ← Back to Polls
        </Button>
        <HStack gap={3} align="center">
          <Text fontSize="xl" color={textColor} textAlign="center">
            Answer at:{" "}
            <Text as="span" fontWeight="semibold" color="#3B82F6">
              {pollUrl}
            </Text>
          </Text>
          <QrCode qrCodeUrl={qrCodeUrl} />
        </HStack>
        <HStack gap={2}>
          <Button
            variant="outline"
            size="sm"
            bg="transparent"
            borderColor={buttonBorderColor}
            color={buttonTextColor}
            disabled={!poll_id || !poll}
            _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
            onClick={async () => {
              if (!poll_id || !poll) return;
              try {
                await livePolls.update(poll_id as string, { is_live: !poll.is_live });
              } catch (error) {
                console.error("Failed to update poll:", error);
              }
            }}
            data-testid="toggle-poll-button"
            aria-label={poll?.is_live ? "Stop Poll" : "Start Poll"}
          >
            {poll?.is_live ? "Stop Poll" : "Start Poll"}
          </Button>
          <Button size="sm" bg="blue.500" color="white" _hover={{ bg: "blue.600" }} onClick={onPresent}>
            Present
          </Button>
        </HStack>
      </HStack>
    </Box>
  );
}
