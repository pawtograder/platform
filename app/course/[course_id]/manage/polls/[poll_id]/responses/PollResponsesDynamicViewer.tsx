"use client";

import { useState, useCallback } from "react";
import MultipleChoiceDynamicViewer from "./MultipleChoiceDynamicViewer";
import PollResponsesHeader from "./PollResponsesHeader";

function parseJsonForType(pollQuestion: JSON): "radio-group" | "single-choice" | "open-ended" | "rating" | "text" {
    const json = pollQuestion as any;
    if (!json.type) {
        throw new Error("Poll question JSON must have a 'type' field");
    }
    return json.type;
}

type PollResponsesDynamicViewerProps = {
    courseId: string;
    pollId: string;
    pollQuestion: JSON;
    pollIsLive: boolean;
    responses: any[];
    timezone: string;
};

export default function PollResponsesDynamicViewer({
    courseId,
    pollId,
    pollQuestion,
    pollIsLive: initialPollIsLive,
    responses,
    timezone
}: PollResponsesDynamicViewerProps) {
    const [isPresenting, setIsPresenting] = useState(false);
    const [pollIsLive, setPollIsLive] = useState(initialPollIsLive);
    
    const type = parseJsonForType(pollQuestion);

    const handlePresent = useCallback(() => {
        setIsPresenting(true);
    }, []);

    const handleClosePresent = useCallback(() => {
        setIsPresenting(false);
    }, []);

    const handlePollStatusChange = useCallback((isLive: boolean) => {
        setPollIsLive(isLive);
    }, []);

    // Render fullscreen present view
    if (isPresenting) {
        switch (type) {
            case "radio-group":
                return <MultipleChoiceDynamicViewer pollQuestion={pollQuestion} responses={responses} onClose={handleClosePresent} />;
            default:
                return <div>Unsupported poll question type: {type}</div>;
        }
    }

    // Render normal view with header
    return (
        <>
            <PollResponsesHeader 
                courseID={courseId} 
                pollID={pollId}
                pollIsLive={pollIsLive}
                onPresent={handlePresent}
                onPollStatusChange={handlePollStatusChange}
            />
            <div>
                {/* Regular view content will go here - for now just showing the type */}
                Poll type: {type}
            </div>
        </>
    );
}
