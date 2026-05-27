"use client";
import Markdown from "@/components/ui/markdown";
import { Tooltip } from "@/components/ui/tooltip";
import { Box, HStack, Icon, Text, VStack } from "@chakra-ui/react";
import { useState } from "react";
import { FaInfo, FaRobot } from "react-icons/fa";

import { GraderResultTestExtraData } from "@/utils/supabase/DatabaseTypes";
import { HintFeedbackForm } from "@/components/submission-results/HintFeedbackForm";
import { LLMHintButton } from "@/components/submission-results/LLMHintButton";

export function TestResultOutput({
  result,
  testId,
  extraData,
  submissionId,
  classId
}: {
  result: {
    output: string | null | undefined;
    output_format: string | null | undefined;
  };
  testId?: number;
  extraData?: GraderResultTestExtraData;
  submissionId?: number;
  classId?: number;
}) {
  const [hintContent, setHintContent] = useState<string | null>(null);

  // Check if there's already a stored LLM hint result
  const storedHintResult = extraData?.llm?.result;
  const displayHint = hintContent || storedHintResult;
  const hasLLMPrompt = extraData?.llm?.prompt;

  return (
    <VStack align="stretch" gap={4}>
      {/* Always show the original output */}
      {format_basic_output(result)}

      {/* Show LLM section if there's a prompt */}
      {hasLLMPrompt && (
        <>
          {displayHint ? (
            /* Show Feedbot response if available */
            <Box
              fontSize="sm"
              overflowX="auto"
              border="1px solid"
              borderColor="border.emphasized"
              borderRadius="md"
              p={0}
            >
              <HStack
                p={2}
                w="100%"
                bg="bg.info"
                borderTopRadius="md"
                color="fg.info"
                fontWeight="bold"
                justify="space-between"
              >
                <HStack>
                  <Icon as={FaRobot} />
                  Response from Feedbot
                </HStack>
                <Tooltip
                  content="Feedbot is an AI-powered assistant that is currently in research & development. We welcome feedback to help us improve!"
                  openDelay={0}
                >
                  <Icon as={FaInfo} />
                </Tooltip>
              </HStack>
              <Box p={2}>
                <Markdown>{displayHint}</Markdown>
                {testId && submissionId && classId && (
                  <HintFeedbackForm
                    testId={testId}
                    submissionId={submissionId}
                    classId={classId}
                    hintText={displayHint}
                  />
                )}
              </Box>
            </Box>
          ) : (
            /* Show hint button if no result yet */
            <Box fontSize="sm">
              <Text color="text.muted" mb={3}>
                Click below to generate response from Feedbot.
              </Text>
              {testId && <LLMHintButton testId={testId} onHintGenerated={setHintContent} />}
            </Box>
          )}
        </>
      )}
    </VStack>
  );
}

export function format_basic_output(result: {
  output: string | null | undefined;
  output_format: string | null | undefined;
}) {
  if (result.output === undefined && result.output_format === undefined) {
    return (
      <Text textStyle="sm" color="text.muted">
        No output
      </Text>
    );
  }
  if (result.output_format === "text" || result.output_format === null) {
    return (
      <Box fontSize="sm" overflowX="auto">
        <pre>{result.output}</pre>
      </Box>
    );
  }
  if (result.output_format === "markdown") {
    return (
      <Box fontSize="sm" overflowX="auto">
        <Markdown>{result.output}</Markdown>
      </Box>
    );
  }
  return <Text fontSize="sm">{result.output}</Text>;
}
