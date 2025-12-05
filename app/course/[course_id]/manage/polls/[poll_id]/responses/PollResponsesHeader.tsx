"use client";

import { HStack, Button, Box, Text } from "@chakra-ui/react";
import { useRouter } from "next/navigation";
import { useColorModeValue } from "@/components/ui/color-mode";
import QrCode from "./QrCode";

type PollResponsesHeaderProps = {
  courseID: string;
  pollID: string;
  pollIsLive: boolean;
  pollUrl: string;
  onPresent: () => void;
  onToggleLive: () => void;
  qrCodeUrl?: string | null;
};

export default function PollResponsesHeader({
  courseID,
  pollIsLive,
  pollUrl,
  onPresent,
  onToggleLive,
  qrCodeUrl
}: PollResponsesHeaderProps) {
  const router = useRouter();

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
          borderColor={buttonBorderColor}
          color={buttonTextColor}
          _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
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
            onClick={onToggleLive}
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
