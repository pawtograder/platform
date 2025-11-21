"use client";

import { useState, useCallback, useMemo } from "react";
import { Box } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import MultipleChoiceDynamicViewer from "./MultipleChoiceDynamicViewer";
import PollResponsesHeader from "./PollResponsesHeader";

function parseJsonForType(pollQuestion: JSON): "radiogroup" | "checkbox" | "single-choice" | "open-ended" | "rating" | "text" {
    const questionData = (pollQuestion as unknown) as Record<string, unknown> | null;
    const type = (questionData?.elements as unknown as { type: string }[])?.[0]?.type;
    if (!type) {
        throw new Error("Poll question JSON must have a 'type' field in elements[0]");
    }
    return type as "radiogroup" | "checkbox" | "single-choice" | "open-ended" | "rating" | "text";
}

type PollResponsesDynamicViewerProps = {
    courseId: string;
    pollId: string;
    pollQuestion: JSON;
    pollIsLive: boolean;
    responses: any[];
};

export default function PollResponsesDynamicViewer({
    courseId,
    pollId,
    pollQuestion,
    pollIsLive: initialPollIsLive,
    responses,
}: PollResponsesDynamicViewerProps) {
    const [isPresenting, setIsPresenting] = useState(false);
    const [pollIsLive, setPollIsLive] = useState(initialPollIsLive);
    
    const type = parseJsonForType(pollQuestion);

    // Calculate poll URL
    const pollUrl = useMemo(() => {
        if (typeof window === "undefined") return "";
        const hostname = window.location.hostname;
        if (hostname === "localhost" || hostname === "127.0.0.1") {
            return `${hostname}:${window.location.port || 3000}/livepoll/${courseId}`;
        }
        return `${hostname}/livepoll/${courseId}`;
    }, [courseId]);

    const handlePresent = useCallback(() => {
        setIsPresenting(true);
    }, []);

    const handleClosePresent = useCallback(() => {
        setIsPresenting(false);
    }, []);

    const handlePollStatusChange = useCallback((isLive: boolean) => {
        setPollIsLive(isLive);
    }, []);

    // Render full window present view
    if (isPresenting) {
        switch (type) {
            case "radiogroup":
            case "checkbox":
                return <MultipleChoiceDynamicViewer pollQuestion={pollQuestion} responses={responses} isFullWindow={true} onExit={handleClosePresent} pollUrl={pollUrl} />;
            default:
                return (
                    <Box position="fixed" inset="0" bg={useColorModeValue("#E5E5E5", "#1A1A1A")} zIndex="9999" display="flex" alignItems="center" justifyContent="center">
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
                pollID={pollId}
                pollIsLive={pollIsLive}
                onPresent={handlePresent}
                onPollStatusChange={handlePollStatusChange}
            />
            {type === "radiogroup" || type === "checkbox" ? (
                <MultipleChoiceDynamicViewer pollQuestion={pollQuestion} responses={responses} isFullWindow={false} />
            ) : (
                <div>Unsupported poll question type: {type}</div>
            )}
        </div>
    );
}
