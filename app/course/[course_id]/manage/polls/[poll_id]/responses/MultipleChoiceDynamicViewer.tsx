"use client";

import { Box, VStack, Heading, Text } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer } from "recharts";
import { useMemo, useEffect, useRef } from "react";
import { CloseButton } from "@/components/ui/close-button";

type PollResponse = {
    id: string;
    live_poll_id: string;
    public_profile_id: string;
    response: Record<string, unknown>;
    submitted_at: string | null;
    is_submitted: boolean;
    created_at: string;
    profile_name: string;
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
    pollUrl,
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
                if (element.requestFullscreen) {
                    await element.requestFullscreen();
                } else if ((element as any).webkitRequestFullscreen) {
                    // Safari
                    await (element as any).webkitRequestFullscreen();
                } else if ((element as any).mozRequestFullScreen) {
                    // Firefox
                    await (element as any).mozRequestFullScreen();
                } else if ((element as any).msRequestFullscreen) {
                    // IE/Edge
                    await (element as any).msRequestFullscreen();
                }
            } catch (error) {
                console.error("Error entering fullscreen:", error);
            }
        };

        enterFullscreen();

        // Handle fullscreen change events (user might exit via browser controls)
        const handleFullscreenChange = () => {
            const isFullscreen = !!(
                document.fullscreenElement ||
                (document as any).webkitFullscreenElement ||
                (document as any).mozFullScreenElement ||
                (document as any).msFullscreenElement
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
                    if (document.exitFullscreen) {
                        await document.exitFullscreen();
                    } else if ((document as any).webkitExitFullscreen) {
                        await (document as any).webkitExitFullscreen();
                    } else if ((document as any).mozCancelFullScreen) {
                        await (document as any).mozCancelFullScreen();
                    } else if ((document as any).msExitFullscreen) {
                        await (document as any).msExitFullscreen();
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
                        if (document.exitFullscreen) {
                            await document.exitFullscreen();
                        } else if ((document as any).webkitExitFullscreen) {
                            await (document as any).webkitExitFullscreen();
                        } else if ((document as any).mozCancelFullScreen) {
                            await (document as any).mozCancelFullScreen();
                        } else if ((document as any).msExitFullscreen) {
                            await (document as any).msExitFullscreen();
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

    const questionData = (pollQuestion as unknown) as Record<string, unknown> | null;
    const firstElement = (questionData?.elements as unknown as Array<{ title: string; choices: string[] | Array<{ text?: string; label?: string; value?: string }> }>)?.[0];
    const questionPrompt = firstElement?.title || "Poll";
    // Handle choices as either string array or object array
    const choicesRaw = firstElement?.choices || [];
    const choices = choicesRaw.map((choice) => {
        if (typeof choice === "string") return choice;
        return choice.text || choice.label || choice.value || String(choice);
    });

    const chartData = useMemo(() => {
        const submittedResponses = responses.filter((r) => r.is_submitted);
        const choiceCounts: Record<string, number> = {};

        choices.forEach((choice) => {
            choiceCounts[choice] = 0;
        });

        submittedResponses.forEach((response) => {
            const answer = response.response.poll_question;

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
            value,
        }));
    }, [responses, choices]);

    const containerProps = isFullWindow
        ? {
            w: "100vw",
            h: "100vh",
            bg: cardBgColor,
            display: "flex",
            flexDirection: "column" as const,
            p: 8,
        }
        : {
            bg: cardBgColor,
            borderRadius: "lg",
            p: 6,
            border: "1px solid",
            borderColor: borderColor,
        };

    const handleExit = () => {
        // Exit fullscreen first
        const exitFullscreen = async () => {
            try {
                if (document.exitFullscreen) {
                    await document.exitFullscreen();
                } else if ((document as any).webkitExitFullscreen) {
                    await (document as any).webkitExitFullscreen();
                } else if ((document as any).mozCancelFullScreen) {
                    await (document as any).mozCancelFullScreen();
                } else if ((document as any).msExitFullscreen) {
                    await (document as any).msExitFullscreen();
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
        <Box {...containerProps} ref={fullscreenRef}>
            {isFullWindow && (
                <Box position="absolute" top={4} right={4} zIndex={10000}>
                    <CloseButton
                        onClick={handleExit}
                        aria-label="Exit fullscreen"
                        size="lg"
                    />
                </Box>
            )}
            {isFullWindow && pollUrl && (
                <Box position="absolute" bottom={4} right={4} zIndex={10000}>
                    <Text fontSize="sm" color={textColor} textAlign="right">
                        Answer Live at:{" "}
                        <Text as="span" fontWeight="semibold" color="#3B82F6">
                            {pollUrl}
                        </Text>
                    </Text>
                </Box>
            )}
            <VStack align="stretch" gap={4} flex="1" minH={isFullWindow ? "0" : "400px"}>
                <Heading size={isFullWindow ? "xl" : "lg"} color={textColor} textAlign="center">
                    {questionPrompt}
                </Heading>
                <Box flex="1" minH="0">
                    <ResponsiveContainer width="100%" height={isFullWindow ? "100%" : "400px"}>
                        <BarChart
                            data={chartData}
                            layout="vertical"
                            margin={{ top: 20, right: 30, left: 150, bottom: 20 }}
                        >
                            <XAxis
                                type="number"
                                tick={{ fill: tickColor }}
                                allowDecimals={false}
                                domain={[0, "dataMax"]}
                                tickFormatter={(value) => Number.isInteger(value) ? String(value) : ""}
                            />
                            <YAxis
                                type="category"
                                dataKey="name"
                                tick={{ fill: tickColor }}
                                width={140}
                            />
                            <Bar dataKey="value" fill="#3B82F6" />
                        </BarChart>
                    </ResponsiveContainer>
                </Box>
            </VStack>
        </Box>
    );
}
