"use client";

import { HStack, Button, Box, Text } from "@chakra-ui/react";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { createClient } from "@/utils/supabase/client";
import { toaster } from "@/components/ui/toaster";
import { useColorModeValue } from "@/components/ui/color-mode";
import QrCode from "./QrCode";

type PollResponsesHeaderProps = {
  courseID: string;
  pollID: string;
  pollIsLive: boolean;
  pollUrl: string;
  onPresent: () => void;
  onPollStatusChange: (isLive: boolean) => void;
  qrCodeUrl?: string | null;
};

export default function PollResponsesHeader({
  courseID,
  pollID,
  pollIsLive,
  pollUrl,
  onPresent,
  qrCodeUrl
}: PollResponsesHeaderProps) {
  const router = useRouter();

  const buttonTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const buttonBorderColor = useColorModeValue("#6B7280", "#4A5568");
  const textColor = useColorModeValue("#1A202C", "#FFFFFF");

  const handleToggleLive = useCallback(async () => {
    const nextState = !pollIsLive;
    const supabase = createClient();
    const loadingToast = toaster.create({
      title: nextState ? "Starting Poll" : "Closing Poll",
      description: nextState ? "Making poll available to students..." : "Closing poll for students...",
      type: "loading"
    });

    try {
      const updateData: { is_live: boolean; deactivates_at: string | null } = {
        is_live: nextState,
        deactivates_at: nextState ? new Date(Date.now() + 60 * 60 * 1000).toISOString() : null
      };

      const { error } = await supabase.from("live_polls").update(updateData).eq("id", pollID);

      if (error) {
        throw new Error(error.message);
      }

      toaster.dismiss(loadingToast);
      toaster.create({
        title: nextState ? "Poll is Live" : "Poll Closed",
        description: nextState ? "Students can now answer this poll." : "Students can no longer submit responses.",
        type: "success"
      });
    } catch (err) {
      toaster.dismiss(loadingToast);
      toaster.create({
        title: "Unable to update poll",
        description: err instanceof Error ? err.message : "An unexpected error occurred",
        type: "error"
      });
    }
  }, [pollID, pollIsLive]);

  return (
    <Box p={4}>
      <HStack justify="space-between" align="center" gap={4}>
        <Button
          variant="outline"
          size="sm"
          bg="transparent"
          borderColor={buttonBorderColor}
          color={buttonTextColor}
          _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
          onClick={() => router.push(`/course/${courseID}/manage/polls`)}
        >
          ← Back to Polls
        </Button>
        <HStack gap={3} align="center">
          <Text fontSize="xl" color={textColor} textAlign="center">
            Answer Live at:{" "}
            <Text as="span" fontWeight="semibold" color="#3B82F6">
              {pollUrl}
            </Text>
          </Text>
          <QrCode qrCodeUrl={qrCodeUrl ?? null} />
        </HStack>
        <HStack gap={2}>
          <Button
            variant="outline"
            size="sm"
            bg="transparent"
            borderColor={buttonBorderColor}
            color={buttonTextColor}
            _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
            onClick={handleToggleLive}
          >
            {pollIsLive ? "Stop Poll" : "Start Poll"}
          </Button>
          <Button size="sm" bg="#3B82F6" color="white" _hover={{ bg: "#2563EB" }} onClick={onPresent}>
            Present
          </Button>
        </HStack>
      </HStack>
    </Box>
  );
}
