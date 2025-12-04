"use client";
import { useState, useCallback, useMemo } from "react";
import { Box } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import MultipleChoiceDynamicViewer from "./MultipleChoiceDynamicViewer";
import PollResponsesHeader from "./PollResponsesHeader";
import { Json } from "@/utils/supabase/SupabaseTypes";
import { useLivePoll, usePollResponses } from "@/hooks/useCourseController";
import { usePollQrCode } from "@/hooks/usePollQrCode";

function parseJsonForType(pollQuestion: Json): "radiogroup" | "checkbox" {
  const questionData = pollQuestion as unknown as Record<string, unknown> | null;
  const type = (questionData?.elements as unknown as { type: string }[])?.[0]?.type;
  if (!type) {
    throw new Error("Poll question JSON must have a 'type' field in elements[0]");
  }
  return type as "radiogroup" | "checkbox";
}

type PollResponsesDynamicViewerProps = {
  courseId: string;
  pollId: string;
  pollQuestion: Json;
  pollIsLive: boolean;
};

export default function PollResponsesDynamicViewer({
  courseId,
  pollId,
  pollQuestion,
  pollIsLive: initialPollIsLive
}: PollResponsesDynamicViewerProps) {
  const [isPresenting, setIsPresenting] = useState(false);

  // Use real-time hooks for poll data and responses
  const poll = useLivePoll(pollId);
  const { responses } = usePollResponses(pollId);

  // Use real-time poll status if available, otherwise fallback to initial
  const pollIsLive = poll?.is_live ?? initialPollIsLive;

  // Define color mode values at the top level (before any conditional returns)
  const bgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const qrLightColor = useColorModeValue("#FFFFFF", "#000000");
  const qrDarkColor = useColorModeValue("#000000", "#FFFFFF");

  const type = parseJsonForType(pollQuestion);

  // Calculate poll URL
  const pollUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    const hostname = window.location.hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return `${hostname}:${window.location.port || 3000}/poll/${courseId}`;
    }
    return `${hostname}/poll/${courseId}`;
  }, [courseId]);

  // Generate and upload QR code to storage (once per course since pollUrl is the same for all polls)
  const { qrCodeUrl } = usePollQrCode(courseId, pollUrl, qrLightColor, qrDarkColor); 

  const handlePresent = useCallback(() => {
    setIsPresenting(true);
  }, []); 

  const handleClosePresent = useCallback(() => {
    setIsPresenting(false);
  }, []);

  const handlePollStatusChange = useCallback(() => { }, []);

  // Render full window present view
  if (isPresenting) {
    switch (type) {
      case "radiogroup":
      case "checkbox":
        return (
          <MultipleChoiceDynamicViewer
            pollQuestion={pollQuestion as unknown as JSON}
            responses={responses}
            isFullWindow={true}
            onExit={handleClosePresent}
            pollUrl={pollUrl}
            qrCodeUrl={qrCodeUrl}
          />
        );
      default:
        return (
          <Box
            position="fixed"
            inset="0"
            bg={bgColor}
            zIndex="9999"
            display="flex"
            alignItems="center"
            justifyContent="center"
          >
            <div>Unsupported poll question type: {type}</div>
          </Box>
        );
    }
  }

  // Render normal view with header
  return (
    <div>
      <PollResponsesHeader
        courseID={courseId}
        pollUrl={pollUrl}
        pollID={pollId}
        pollIsLive={pollIsLive}
        onPresent={handlePresent}
        onPollStatusChange={handlePollStatusChange}
        qrCodeUrl={qrCodeUrl}
      />
      {type === "radiogroup" || type === "checkbox" ? (
        <Box mt={4}>
          <MultipleChoiceDynamicViewer
            pollQuestion={pollQuestion as unknown as JSON}
            responses={responses}
            isFullWindow={false}
            pollUrl={pollUrl}
            qrCodeUrl={qrCodeUrl}
          />
        </Box>
      ) : (
        <div>Unsupported poll question type: {type}</div>
      )}
    </div>
  );
}
