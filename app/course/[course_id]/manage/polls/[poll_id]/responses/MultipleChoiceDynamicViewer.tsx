"use client";

import { Box, VStack, Heading, Text } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer } from "recharts";
import { useMemo, useEffect, useRef } from "react";
import { CloseButton } from "@/components/ui/close-button";
import { PollResponseData } from "@/types/poll";
import { getPollAnswer } from "@/utils/pollUtils";

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

type PollResponse = {
  id: string;
  live_poll_id: string;
  public_profile_id: string;
  response: PollResponseData | null;
};

type MultipleChoiceDynamicViewerProps = {
  pollQuestion: JSON;
  responses: PollResponse[];
  isFullWindow?: boolean;
  onExit?: () => void;
  pollUrl?: string;
};

export default function MultipleChoiceDynamicViewer({
  pollQuestion,
  responses,
  isFullWindow = false,
  onExit,
  pollUrl
}: MultipleChoiceDynamicViewerProps) {
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const tickColor = useColorModeValue("#1A202C", "#FFFFFF");
  const fullscreenRef = useRef<HTMLDivElement>(null);

  // Handle fullscreen API
  useEffect(() => {
    if (!isFullWindow || !fullscreenRef.current) return;

    const element = fullscreenRef.current;

    // Enter fullscreen
    const enterFullscreen = async () => {
      try {
        const fullscreenElement = element as FullscreenElement;
        if (fullscreenElement.requestFullscreen) {
          await fullscreenElement.requestFullscreen();
        } else if (fullscreenElement.webkitRequestFullscreen) {
          // Safari
          await fullscreenElement.webkitRequestFullscreen();
        } else if (fullscreenElement.mozRequestFullScreen) {
          // Firefox
          await fullscreenElement.mozRequestFullScreen();
        } else if (fullscreenElement.msRequestFullscreen) {
          // IE/Edge
          await fullscreenElement.msRequestFullscreen();
        }
      } catch (error) {
        console.error("Error entering fullscreen:", error);
      }
    };

    enterFullscreen();

    // Handle fullscreen change events (user might exit via browser controls)
    const handleFullscreenChange = () => {
      const fullscreenDoc = document as FullscreenDocument;
      const isFullscreen = !!(
        document.fullscreenElement ||
        fullscreenDoc.webkitFullscreenElement ||
        fullscreenDoc.mozFullScreenElement ||
        fullscreenDoc.msFullscreenElement
      );

      if (!isFullscreen && onExit) {
        onExit();
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

      // Exit fullscreen on cleanup
      const exitFullscreen = async () => {
        try {
          const fullscreenDoc = document as FullscreenDocument;
          if (document.exitFullscreen) {
            await document.exitFullscreen();
          } else if (fullscreenDoc.webkitExitFullscreen) {
            await fullscreenDoc.webkitExitFullscreen();
          } else if (fullscreenDoc.mozCancelFullScreen) {
            await fullscreenDoc.mozCancelFullScreen();
          } else if (fullscreenDoc.msExitFullscreen) {
            await fullscreenDoc.msExitFullscreen();
          }
        } catch (error) {
          console.error("Error exiting fullscreen:", error);
        }
      };

      exitFullscreen();
    };
  }, [isFullWindow, onExit]);

  // Handle Escape key to exit full window mode
  useEffect(() => {
    if (!isFullWindow || !onExit) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Exit fullscreen first, then call onExit
        const exitFullscreen = async () => {
          try {
            const fullscreenDoc = document as FullscreenDocument;
            if (document.exitFullscreen) {
              await document.exitFullscreen();
            } else if (fullscreenDoc.webkitExitFullscreen) {
              await fullscreenDoc.webkitExitFullscreen();
            } else if (fullscreenDoc.mozCancelFullScreen) {
              await fullscreenDoc.mozCancelFullScreen();
            } else if (fullscreenDoc.msExitFullscreen) {
              await fullscreenDoc.msExitFullscreen();
            }
          } catch (error) {
            console.error("Error exiting fullscreen:", error);
          }
        };
        exitFullscreen();
        onExit();
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isFullWindow, onExit]);

  const questionData = pollQuestion as unknown as Record<string, unknown> | null;
  const firstElement = (
    questionData?.elements as unknown as Array<{
      title: string;
      choices: string[] | Array<{ text?: string; label?: string; value?: string }>;
    }>
  )?.[0];
  const questionPrompt = firstElement?.title || "Poll";
  // Handle choices as either string array or object array
  const choicesRaw = firstElement?.choices || [];
  const choices = choicesRaw.map((choice) => {
    if (typeof choice === "string") return choice;
    return choice.text || choice.label || choice.value || String(choice);
  });

  const chartData = useMemo(() => {
    const choiceCounts: Record<string, number> = {};

    choices.forEach((choice) => {
      choiceCounts[choice] = 0;
    });

    responses.forEach((response) => {
      const answer = getPollAnswer(response.response);

      if (Array.isArray(answer)) {
        answer.forEach((item: string) => {
          if (!item.startsWith("other:") && choiceCounts.hasOwnProperty(item)) {
            choiceCounts[item]++;
          }
        });
      } else if (typeof answer === "string" && !answer.startsWith("other:") && choiceCounts.hasOwnProperty(answer)) {
        choiceCounts[answer]++;
      }
    });

    return Object.entries(choiceCounts).map(([name, value]) => ({
      name,
      value
    }));
  }, [responses, choices]);

  // Calculate max value for X-axis with padding
  const xAxisMax = useMemo(() => {
    if (chartData.length === 0) return 10;

    const maxValue = Math.max(...chartData.map((d) => d.value));

    if (maxValue === 0) return 10;

    // Add 20% padding
    const paddedValue = maxValue * 1.2;

    // Round up to a number based on scale
    if (paddedValue <= 5) {
      return Math.ceil(paddedValue);
    } else if (paddedValue <= 20) {
      return Math.ceil(paddedValue / 5) * 5;
    } else if (paddedValue <= 100) {
      return Math.ceil(paddedValue / 10) * 10;
    } else if (paddedValue <= 500) {
      return Math.ceil(paddedValue / 50) * 50;
    } else {
      return Math.ceil(paddedValue / 100) * 100;
    }
  }, [chartData]);

  const containerProps = isFullWindow
    ? {
        w: "100vw",
        h: "100vh",
        bg: cardBgColor,
        display: "flex",
        flexDirection: "column" as const,
        p: 8
      }
    : {
        bg: cardBgColor,
        borderRadius: "2xl",
        p: 10,
        border: "1px solid",
        borderColor: borderColor,
        display: "flex",
        flexDirection: "column" as const,
        minH: "700px",
        maxW: "1400px",
        w: "95%",
        mx: "auto",
        boxShadow: "lg"
      };

  const handleExit = () => {
    const exitFullscreen = async () => {
      try {
        const fullscreenDoc = document as FullscreenDocument;
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if (fullscreenDoc.webkitExitFullscreen) {
          await fullscreenDoc.webkitExitFullscreen();
        } else if (fullscreenDoc.mozCancelFullScreen) {
          await fullscreenDoc.mozCancelFullScreen();
        } else if (fullscreenDoc.msExitFullscreen) {
          await fullscreenDoc.msExitFullscreen();
        }
      } catch (error) {
        console.error("Error exiting fullscreen:", error);
      }
    };
    exitFullscreen();
    if (onExit) {
      onExit();
    }
  };

  return (
    <Box
      display={isFullWindow ? "flex" : "flex"}
      justifyContent={isFullWindow ? "stretch" : "center"}
      alignItems={isFullWindow ? "stretch" : "center"}
      minH={isFullWindow ? "100vh" : "82.5vh"}
      w={isFullWindow ? "100%" : "100%"}
      //shift the box up by 10px
      mt={isFullWindow ? 0 : -5}
    >
      <Box {...containerProps} ref={fullscreenRef}>
        {isFullWindow && (
          <Box position="absolute" top={4} right={4} zIndex={10000}>
            <CloseButton onClick={handleExit} aria-label="Exit fullscreen" size="xl" />
          </Box>
        )}
        {isFullWindow && pollUrl && (
          <Box position="absolute" bottom={4} right={4} zIndex={10000}>
            <Text fontSize="2xl" color={textColor} textAlign="right">
              Answer Live at:{" "}
              <Text as="span" fontWeight="semibold" color="#3B82F6">
                {pollUrl}
              </Text>
            </Text>
          </Box>
        )}
        <VStack align="center" justify="center" gap={4} flex="1" minH="0" w="100%">
          <Heading size={isFullWindow ? "xl" : "lg"} color={textColor} textAlign="center">
            {questionPrompt}
          </Heading>
          <Box w="100%" translate="auto" translateX="-20px">
            <ResponsiveContainer width="100%" height={isFullWindow ? 700 : 500}>
              <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 100, top: 0, bottom: 0 }}>
                <XAxis
                  type="number"
                  tick={{ fill: tickColor, fontSize: 10 }}
                  allowDecimals={false}
                  domain={[0, xAxisMax]}
                  tickFormatter={(value) => (Number.isInteger(value) ? String(value) : "")}
                />
                <YAxis type="category" dataKey="name" tick={{ fill: tickColor, fontSize: 12 }} width={200} />
                <Bar dataKey="value" fill="#3B82F6" barSize={isFullWindow ? 150 : 100} />
              </BarChart>
            </ResponsiveContainer>
          </Box>
          <Text fontSize="md" color={textColor} textAlign="center">
            Number of Responses
          </Text>
        </VStack>
      </Box>
    </Box>
  );
}
