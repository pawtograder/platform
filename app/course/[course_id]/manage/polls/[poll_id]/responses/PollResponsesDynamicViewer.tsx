"use client";
import { useState, useCallback, useMemo, useEffect } from "react";
import { Box } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import MultipleChoiceDynamicViewer from "./MultipleChoiceDynamicViewer";
import PollResponsesHeader from "./PollResponsesHeader";
import { createClient } from "@/utils/supabase/client";
import { PollResponseData } from "@/types/poll";
import { Json } from "@/utils/supabase/SupabaseTypes";

type PollResponse = {
    id: string;
    live_poll_id: string;
    public_profile_id: string | null;
    response: PollResponseData | null;
};

function parseJsonForType(pollQuestion: Json): "radiogroup" | "checkbox" | "single-choice" | "open-ended" | "rating" | "text" {
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
    pollQuestion: Json;
    pollIsLive: boolean;
    responses: PollResponse[];
};

export default function PollResponsesDynamicViewer({
    courseId,
    pollId,
    pollQuestion,
    pollIsLive: initialPollIsLive,
    responses: initialResponses,
}: PollResponsesDynamicViewerProps) {
    const [isPresenting, setIsPresenting] = useState(false);
    const [pollIsLive, setPollIsLive] = useState(initialPollIsLive);
    const [responses, setResponses] = useState(initialResponses);
    
    // Define color mode values at the top level (before any conditional returns)
    const bgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
    
    const type = parseJsonForType(pollQuestion);

    // Fetch responses every 3 seconds
    useEffect(() => {
        const fetchResponses = async () => {
            try {
                const supabase = createClient();
                
                const { data: responsesData, error: responsesError } = await supabase
                    .from("live_poll_responses")
                    .select("id, live_poll_id, public_profile_id, response")
                    .eq("live_poll_id", pollId)
                    .order("created_at", { ascending: false });

                if (responsesError) {
                    console.error("Error fetching poll responses:", responsesError);
                    return;
                }

                const fetchedResponses = responsesData || [];

                const enrichedResponses: PollResponse[] = fetchedResponses.map((response) => ({
                    id: response.id,
                    live_poll_id: response.live_poll_id,
                    public_profile_id: response.public_profile_id,
                    response: (response.response as PollResponseData) || null,
                }));

                // Update state - React will only re-render the chart, not the entire page
                setResponses(enrichedResponses);
            } catch (error) {
                console.error("Error in fetchResponses:", error);
            }
        };

        // Fetch immediately
        fetchResponses();

        // Then fetch every 3 seconds
        const interval = setInterval(fetchResponses, 3000);

        return () => clearInterval(interval);
    }, [pollId]);

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

    const handlePollStatusChange = useCallback((isLive: boolean) => {
        setPollIsLive(isLive);
    }, []);

    // Render full window present view
    if (isPresenting) {
        switch (type) {
            case "radiogroup":
            case "checkbox":
                return <MultipleChoiceDynamicViewer pollQuestion={pollQuestion as unknown as JSON} responses={responses.filter((r): r is PollResponse & { public_profile_id: string } => r.public_profile_id !== null)} isFullWindow={true} onExit={handleClosePresent} pollUrl={pollUrl} />;
            default:
                return (
                    <Box position="fixed" inset="0" bg={bgColor} zIndex="9999" display="flex" alignItems="center" justifyContent="center">
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
                <MultipleChoiceDynamicViewer pollQuestion={pollQuestion as unknown as JSON} responses={responses.filter((r): r is PollResponse & { public_profile_id: string } => r.public_profile_id !== null)} isFullWindow={false} />
            ) : (
                <div>Unsupported poll question type: {type}</div>
            )}
        </div>
    );
}
