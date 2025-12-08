"use client";
import { useState, useCallback, useMemo } from "react";
import { Box } from "@chakra-ui/react";
import MultipleChoiceDynamicViewer from "./MultipleChoiceDynamicViewer";
import PollResponsesHeader from "./PollResponsesHeader";
import { Json } from "@/utils/supabase/SupabaseTypes";
import { useLivePoll, usePollResponses } from "@/hooks/useCourseController";

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

  const handlePresent = useCallback(() => {
    setIsPresenting(true);
  }, []);

  const handleClosePresent = useCallback(() => {
    setIsPresenting(false);
  }, []);

  const handlePollStatusChange = useCallback(() => {}, []);

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
          />
        );
      default:
        return (
          <Box
            position="fixed"
            inset="0"
            bg="bg.subtle"
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
      />
      {type === "radiogroup" || type === "checkbox" ? (
        <MultipleChoiceDynamicViewer
          pollQuestion={pollQuestion as unknown as JSON}
          responses={responses}
          isFullWindow={false}
          pollUrl={pollUrl}
        />
      ) : (
        <div>Unsupported poll question type: {type}</div>
      )}
    </div>
  );
}
