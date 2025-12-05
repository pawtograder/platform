"use client";
import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { Box } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import MultipleChoiceDynamicViewer from "./MultipleChoiceDynamicViewer";
import PollResponsesHeader from "./PollResponsesHeader";
import { Json } from "@/utils/supabase/SupabaseTypes";
import { useLivePoll, usePollResponses } from "@/hooks/useCourseController";
import { usePollQrCode } from "@/hooks/usePollQrCode";
import { CloseButton } from "@/components/ui/close-button";

interface FullscreenElement extends Element {
  webkitRequestFullscreen?: () => Promise<void>;
  mozRequestFullScreen?: () => Promise<void>;
  msRequestFullscreen?: () => Promise<void>;
}

interface FullscreenDocument extends Document {
  webkitFullscreenElement?: Element | null;
  mozFullScreenElement?: Element | null;
  msFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
  mozCancelFullScreen?: () => Promise<void>;
  msExitFullscreen?: () => Promise<void>;
}

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
  const fullscreenRef = useRef<HTMLDivElement>(null);

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
      return `${hostname}/poll/${courseId}`;
    }
    return `https://${hostname}/poll/${courseId}`;
  }, [courseId]);

  // Generate and upload QR code to storage (once per course since pollUrl is the same for all polls)
  const { qrCodeUrl } = usePollQrCode(courseId, pollUrl, qrLightColor, qrDarkColor);

  const handlePollStatusChange = useCallback(() => { }, []);

  // Exit fullscreen helper
  const exitFullscreen = useCallback(async () => {
    try {
      const fullscreenDoc = document as FullscreenDocument;
      if (document.fullscreenElement) {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if (fullscreenDoc.webkitExitFullscreen) {
          await fullscreenDoc.webkitExitFullscreen();
        } else if (fullscreenDoc.mozCancelFullScreen) {
          await fullscreenDoc.mozCancelFullScreen();
        } else if (fullscreenDoc.msExitFullscreen) {
          await fullscreenDoc.msExitFullscreen();
        }
      }
    } catch (error) {
      console.error("Error exiting fullscreen:", error);
    }
  }, []);

  // Enter fullscreen and start presenting
  const handlePresent = useCallback(async () => {
    if (!fullscreenRef.current) return;

    setIsPresenting(true);

    try {
      const element = fullscreenRef.current as FullscreenElement;
      if (element.requestFullscreen) {
        await element.requestFullscreen();
      } else if (element.webkitRequestFullscreen) {
        await element.webkitRequestFullscreen();
      } else if (element.mozRequestFullScreen) {
        await element.mozRequestFullScreen();
      } else if (element.msRequestFullscreen) {
        await element.msRequestFullscreen();
      }
    } catch (error) {
      console.error("Error entering fullscreen:", error);
    }
  }, []);

  // Exit fullscreen and stop presenting
  const handleClosePresent = useCallback(async () => {
    await exitFullscreen();
    setIsPresenting(false);
  }, [exitFullscreen]);

  // Handle fullscreen change events (user might exit via browser controls)
  useEffect(() => {
    const handleFullscreenChange = () => {
      const fullscreenDoc = document as FullscreenDocument;
      const isFullscreen = !!(
        document.fullscreenElement ||
        fullscreenDoc.webkitFullscreenElement ||
        fullscreenDoc.mozFullScreenElement ||
        fullscreenDoc.msFullscreenElement
      );

      if (!isFullscreen && isPresenting) {
        setIsPresenting(false);
      }
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    document.addEventListener("mozfullscreenchange", handleFullscreenChange);
    document.addEventListener("MSFullscreenChange", handleFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
      document.removeEventListener("mozfullscreenchange", handleFullscreenChange);
      document.removeEventListener("MSFullscreenChange", handleFullscreenChange);
    };
  }, [isPresenting]);

  // Handle Escape key to exit presenting mode
  useEffect(() => {
    if (!isPresenting) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        handleClosePresent();
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isPresenting, handleClosePresent]);

  // Cleanup: exit fullscreen on unmount
  useEffect(() => {
    return () => {
      exitFullscreen();
    };
  }, [exitFullscreen]);

  // Render normal view with header, wrapping viewer in fullscreen-able container
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
        <Box
          ref={fullscreenRef}
          mt={isPresenting ? 0 : 4}
          bg={isPresenting ? bgColor : "transparent"}
          w={isPresenting ? "100vw" : "100%"}
          h={isPresenting ? "100vh" : "auto"}
          position="relative"
        >
          {isPresenting && (
            <Box position="absolute" top={4} right={4} zIndex={10000}>
              <CloseButton onClick={handleClosePresent} aria-label="Exit fullscreen" size="xl" />
            </Box>
          )}
          <MultipleChoiceDynamicViewer
            pollQuestion={pollQuestion as unknown as JSON}
            responses={responses}
            pollUrl={pollUrl}
            qrCodeUrl={qrCodeUrl}
            isFullscreen={isPresenting}
          />
        </Box>
      ) : (
        <div>Unsupported poll question type: {type}</div>
      )}
    </div>
  );
}
