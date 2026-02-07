"use client";

import { toaster } from "@/components/ui/toaster";
import { Tooltip } from "@/components/ui/tooltip";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { IconButton, Icon } from "@chakra-ui/react";
import { useCallback, useState } from "react";
import { BsRobot } from "react-icons/bs";
import { AIHelpFeedbackPanel } from "./AIHelpFeedbackPanel";

interface AIHelpSubmissionErrorButtonProps {
  /** Type of error: test failure or build error */
  errorType: "test_failure" | "build_error";
  /** Test name (for test failures) */
  testName?: string;
  /** Test part/category (for test failures) */
  testPart?: string | null;
  /** Score achieved */
  score?: number;
  /** Maximum possible score */
  maxScore?: number;
  /** The error output to analyze */
  errorOutput: string;
  /** Assignment ID for context */
  assignmentId: number;
  /** Class ID for MCP authorization */
  classId: number;
  /** Submission ID for MCP context */
  submissionId: number;
}

/**
 * Generates an AI prompt for analyzing a test failure or build error
 */
function generateErrorPrompt(props: AIHelpSubmissionErrorButtonProps): string {
  const { errorType, testName, testPart, score, maxScore, errorOutput, assignmentId, classId, submissionId } = props;

  const truncatedOutput = errorOutput.slice(0, 4000) + (errorOutput.length > 4000 ? "\n... (truncated)" : "");

  if (errorType === "build_error") {
    return `You are helping an instructor/TA understand why a student's submission failed to build.

## Build Error

The student's code failed to compile/build. Here is the build output:

\`\`\`
${truncatedOutput}
\`\`\`

## MCP Tools Available

Use the Pawtograder MCP server to fetch additional context:

1. **Get assignment spec/handout**:
   \`\`\`json
   {"tool": "get_assignment", "params": {"assignment_id": ${assignmentId}, "class_id": ${classId}}}
   \`\`\`

2. **Get full submission with files**:
   \`\`\`json
   {"tool": "get_submission", "params": {"submission_id": ${submissionId}, "class_id": ${classId}, "include_test_output": true, "include_files": true}}
   \`\`\`

## Your Task

1. **Identify the root cause** of the build failure from the error output
2. **Explain the issue** in terms the student can understand
3. **Suggest how to fix it** without giving away assignment solutions
4. **Check if this might be an assignment issue** (missing dependencies, unclear instructions, etc.)

If you need more context, use the MCP tools to fetch the assignment handout and submission files.`;
  }

  // Test failure prompt
  return `You are helping an instructor/TA understand why a student is failing a specific test.

## Test Failure Details

- **Test Name**: ${testName}${testPart ? ` (Part: ${testPart})` : ""}
- **Score**: ${score}/${maxScore}
- **Status**: ${score === 0 ? "Failing completely" : "Partial credit"}

## Test Output

\`\`\`
${truncatedOutput}
\`\`\`

## MCP Tools Available

Use the Pawtograder MCP server to fetch additional context:

1. **Get assignment spec/handout**:
   \`\`\`json
   {"tool": "get_assignment", "params": {"assignment_id": ${assignmentId}, "class_id": ${classId}}}
   \`\`\`

2. **Get full submission with all test outputs and files**:
   \`\`\`json
   {"tool": "get_submission", "params": {"submission_id": ${submissionId}, "class_id": ${classId}, "include_test_output": true, "include_files": true}}
   \`\`\`

## Your Task

1. **Analyze the test output** to understand what went wrong
2. **Identify the likely mistake** the student made
3. **Suggest debugging strategies** without revealing the solution
4. **Check if this might be an assignment/test issue** (unclear spec, edge case not covered, etc.)

If you need more context, use the MCP tools to:
- Fetch the assignment handout to understand what's expected
- Fetch the submission files to see the student's code
- Look at other test results to see if there's a pattern`;
}

/**
 * Compact icon button for AI assistance on test failures or build errors.
 * Only visible to instructors and graders.
 * Shows feedback panel after copying prompt.
 */
export function AIHelpSubmissionErrorButton(props: AIHelpSubmissionErrorButtonProps) {
  const isInstructorOrGrader = useIsGraderOrInstructor();
  const [showFeedback, setShowFeedback] = useState(false);

  const handleCopy = useCallback(async () => {
    const prompt = generateErrorPrompt(props);

    try {
      await navigator.clipboard.writeText(prompt);
      toaster.success({
        title: "Copied AI context",
        description:
          props.errorType === "build_error"
            ? "Build error analysis prompt copied to clipboard."
            : `Test failure analysis prompt for "${props.testName}" copied to clipboard.`
      });
      // Show feedback panel after copying
      setShowFeedback(true);
    } catch {
      toaster.error({
        title: "Failed to copy",
        description: "Could not copy to clipboard. Please try again."
      });
    }
  }, [props]);

  // Only show for instructors/graders
  if (!isInstructorOrGrader) {
    return null;
  }

  // Show feedback panel after copying
  if (showFeedback) {
    return (
      <AIHelpFeedbackPanel
        classId={props.classId}
        contextType={props.errorType}
        resourceId={props.submissionId}
        onClose={() => setShowFeedback(false)}
      />
    );
  }

  const tooltipContent =
    props.errorType === "build_error"
      ? "Copy AI prompt to analyze this build error"
      : "Copy AI prompt to analyze this test failure";

  return (
    <Tooltip content={tooltipContent} showArrow>
      <IconButton aria-label={tooltipContent} size="xs" variant="ghost" colorPalette="purple" onClick={handleCopy}>
        <Icon as={BsRobot} />
      </IconButton>
    </Tooltip>
  );
}

export default AIHelpSubmissionErrorButton;
