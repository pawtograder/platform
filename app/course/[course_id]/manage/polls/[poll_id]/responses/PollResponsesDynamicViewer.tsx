"use client";
import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { Box, Text, Link } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import MultipleChoiceDynamicViewer from "./MultipleChoiceDynamicViewer";
import PollResponsesHeader from "./PollResponsesHeader";
import QrCode from "./QrCode";
import { Json } from "@/utils/supabase/SupabaseTypes";
import { useLivePoll } from "@/hooks/useCourseController";
import { usePollQrCode } from "@/hooks/usePollQrCode";
import { CloseButton } from "@/components/ui/close-button";
import { createClient } from "@/utils/supabase/client";
import { toaster } from "@/components/ui/toaster";

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

  // Use real-time hook for poll data
  const poll = useLivePoll(pollId);

  // Use real-time poll status if available, otherwise fallback to initial
  const [pollIsLive, setPollIsLive] = useState(poll?.is_live ?? initialPollIsLive);

  // Sync local state when real-time data changes
  useEffect(() => {
    if (poll?.is_live !== undefined) {
      setPollIsLive(poll.is_live);
    }
  }, [poll?.is_live]);

  // Define color mode values at the top level (before any conditional returns)
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const qrLightColor = useColorModeValue("#FFFFFF", "#000000");
  const qrDarkColor = useColorModeValue("#000000", "#FFFFFF");

  const type = parseJsonForType(pollQuestion);

  // Calculate poll URL
  const pollUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    const hostname = window.location.hostname;
    const port = window.location.port;
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return `${hostname}:${port}/poll/${courseId}`;
    }
    return `https://${hostname}/poll/${courseId}`;
  }, [courseId]);

  // Generate and upload QR code to storage (once per course since pollUrl is the same for all polls)
  const { qrCodeUrl } = usePollQrCode(courseId, pollUrl, qrLightColor, qrDarkColor);

  const handleToggleLive = useCallback(async () => {
    const nextState = !pollIsLive;
    setPollIsLive(nextState);
    const supabase = createClient();
    const loadingToast = toaster.create({
      title: nextState ? "Starting Poll" : "Closing Poll",
      description: nextState ? "Making poll available to students..." : "Closing poll for students...",
      type: "loading"
    });

    try {
      const { error } = await supabase.from("live_polls").update({ is_live: nextState }).eq("id", pollId);

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
      setPollIsLive(pollIsLive);
    }
  }, [pollId, pollIsLive]);

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

  // Handle fullscreen change events
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
        onToggleLive={handleToggleLive}
        qrCodeUrl={qrCodeUrl}
      />
      <Box
        ref={fullscreenRef}
        mt={isPresenting ? 0 : 4}
        bg={cardBgColor}
        w={isPresenting ? "100vw" : "95%"}
        h={isPresenting ? "100vh" : "100%"}
        maxW={isPresenting ? "100%" : "1400px"}
        mx="auto"
        borderRadius={isPresenting ? "none" : "2xl"}
        border={isPresenting ? "none" : "1px solid"}
        borderColor={borderColor}
        boxShadow={isPresenting ? "none" : "lg"}
        p={isPresenting ? 8 : 10}
        display="flex"
        flexDirection="column"
        justifyContent="center"
        alignItems="center"
        position="relative"
      >
        {isPresenting && (
          <>
            <Box position="absolute" top={4} right={4} zIndex={10000}>
              <CloseButton onClick={handleClosePresent} aria-label="Exit fullscreen" size="xl" />
            </Box>
            <Box position="absolute" bottom={4} right={4} zIndex={10000} display="flex" alignItems="center" gap={3}>
              <Text color={textColor} fontSize="lg" fontWeight="medium">
                Answer at:{" "}
                <Link href={pollUrl} target="_blank" color="blue.500" textDecoration="underline">
                  {pollUrl}
                </Link>
              </Text>
              <QrCode qrCodeUrl={qrCodeUrl} size="60px" isFullscreen={true} />
            </Box>
          </>
        )}
        {type === "radiogroup" || type === "checkbox" ? (
          <MultipleChoiceDynamicViewer pollId={pollId} pollQuestion={pollQuestion as unknown as JSON} />
        ) : (
          <div>Unsupported poll question type: {type}</div>
        )}
      </Box>
    </div>
  );
}
