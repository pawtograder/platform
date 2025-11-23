import { PollResponseData } from "@/types/poll";

/**
 * Helper function to extract answer from poll response
 * Response format: { "poll_question_0": "Dynamic Programming" }
 * Keys are dynamic (poll_question_0, poll_question_1, etc.)
 * Values can be string (single choice) or string[] (multiple choice)
 */
export function getPollAnswer(response: PollResponseData | null): string | string[] | null {
    if (!response) return null;
    
    // Find the key that starts with "poll_question_"
    const answerKey = Object.keys(response).find(key => key.startsWith("poll_question_"));
    if (!answerKey) return null;
    
    const answer = response[answerKey];
    return typeof answer === "string" || Array.isArray(answer) ? answer : null;
}

