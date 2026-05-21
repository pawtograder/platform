"use client";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { VStack } from "@chakra-ui/react";
import { useState } from "react";
import { FaRobot, FaSpinner } from "react-icons/fa";
import * as Sentry from "@sentry/nextjs";

export function LLMHintButton({
  testId,
  onHintGenerated
}: {
  testId: number;
  onHintGenerated: (hint: string) => void;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGetHint = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/llm-hint", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          testId
        })
      });

      if (!response.ok) {
        // Try to parse JSON error response
        let errorMessage = "Failed to get Feedbot response";
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorMessage;
        } catch {
          // If JSON parsing fails, use status-based error messages
          switch (response.status) {
            case 400:
              errorMessage = "Invalid request - please check the test configuration";
              break;
            case 401:
              errorMessage = "Authentication required - please refresh the page and try again";
              break;
            case 403:
              errorMessage = "Access denied - you may not have permission to access this feature";
              break;
            case 404:
              errorMessage = "Test result not found or access denied";
              break;
            case 429:
              errorMessage = "Rate limit exceeded.";
              break;
            case 500:
              errorMessage = "Server error - please try again later";
              break;
            default:
              errorMessage = `Request failed with status ${response.status}`;
          }
        }
        throw new Error(errorMessage);
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || "Unexpected response format");
      }

      onHintGenerated(data.response);

      // If this was cached, we could show a different message
      if (data.cached) {
        // eslint-disable-next-line no-console
        console.log("Feedbot response was retrieved from cache");
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to get Feedbot response";
      // eslint-disable-next-line no-console
      console.error("LLM Hint Error:", err);
      setError(errorMessage);

      // Do NOT log rate-limit (429) errors to Sentry — the message is "Rate limit exceeded."
      // (or a server-provided "Rate limit: ..."), so match case-insensitively on "rate limit".
      if (err instanceof Error && /rate limit/i.test(err.message)) {
        return;
      }

      // Log to Sentry for debugging
      Sentry.captureException(err, {
        tags: {
          operation: "llm_hint_client",
          testId: testId.toString()
        },
        extra: {
          testId,
          errorMessage
        }
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <VStack align="stretch" gap={2}>
      <Button onClick={handleGetHint} disabled={isLoading} colorPalette="blue" variant="outline" size="sm">
        {isLoading ? (
          <>
            <FaSpinner className="animate-spin" />
            Getting Feedbot Response...
          </>
        ) : (
          <>
            <FaRobot />
            Get Feedbot Response
          </>
        )}
      </Button>
      {error && (
        <Alert status="error" size="sm">
          {error}
        </Alert>
      )}
    </VStack>
  );
}
