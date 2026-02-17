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

  const toolsSection = `## Available MCP Tools

Use the Pawtograder MCP server to auto-fetch context. **On your first reply, fetch relevant data for a detailed diagnosis.**

### Starting Context (use these IDs when calling tools):
- **Assignment ID**: ${assignmentId}
- **Class ID**: ${classId}
- **Submission ID**: ${submissionId}

### Assignment Context:
- **get_assignment** - Get assignment spec, handout URL, rubric (verify expected behavior)

### Submission & Code Tools:
- **get_submission** - Get submission metadata (timestamp, score, status)
- **list_submission_files** - See what files the student submitted
- **get_submission_files** - Fetch specific source files (glob patterns: "*.java", "src/**/*.py")

### Test & Build Tools:
- **list_submission_tests** - See all test results (pass/fail, scores)
- **get_test_output** - Get detailed output for a specific test
- **get_submission_build_output** - Get compilation/build errors

### History Tools:
- **list_student_submissions** - See student's past submissions to track progress
- **search_discussion_threads** - Find related questions from other students`;

  const responseFormatSection = `## Your Response Format

### 1. Diagnosis with Evidence

Explain what you believe the issue is, and **cite direct evidence** from:
- The student's code (specific line numbers/snippets)
- Test/build output showing the actual vs expected behavior
- Relevant sections of the assignment specification

Example:
> **Evidence**: In \`MyClass.java:42\`, the student writes \`list.get(i)\` without bounds checking. The test output shows \`IndexOutOfBoundsException\` at this line when the list is empty.

This allows the staff member to verify your reasoning against the actual artifacts.

### 2. Draft Response for Student

**Ask about the situation first:**
- **New to this issue?** → Use Socratic questioning: "What do you expect to happen when the list is empty?"
- **Been helping for a while?** → Be direct: "You need to check if the list is empty before calling get()."

**Draft two versions:**

**Version A (Socratic/Exploratory):**
[Draft here - asks questions, guides discovery, encourages debugging]

**Version B (Direct/Efficient):**
[Draft here - clear explanation with concrete next steps]

### 3. Verification Checklist

Before sending, the staff member should verify:
- [ ] The diagnosis matches what I see in the student's code
- [ ] The evidence cited is accurate
- [ ] The response tone matches how long I've been helping this student
- [ ] The hints don't give away too much of the solution

---

**After using this AI help, please provide feedback in Pawtograder** on whether the analysis was accurate and helpful.`;

  if (errorType === "build_error") {
    return `You are helping an instructor/TA understand why a student's submission failed to build.

${toolsSection}

## Build Error

The student's code failed to compile/build. Here is the build output:

\`\`\`
${truncatedOutput}
\`\`\`

**First, fetch:**
1. The assignment spec to understand what files/structure are expected
2. The student's source files (especially those mentioned in the error)
3. The full build output for complete context

${responseFormatSection}`;
  }

  // Test failure prompt
  return `You are helping an instructor/TA understand why a student is failing a specific test.

${toolsSection}

## Test Failure Details

- **Test Name**: ${testName}${testPart ? ` (Part: ${testPart})` : ""}
- **Score**: ${score}/${maxScore}
- **Status**: ${score === 0 ? "Failing completely" : "Partial credit"}

## Test Output

\`\`\`
${truncatedOutput}
\`\`\`

**First, fetch:**
1. The assignment spec to understand expected behavior
2. The student's relevant source files (use list_submission_files first, then fetch with glob patterns)
3. The full test output for this specific test
4. Optionally: the student's past submissions to see if they're making progress

${responseFormatSection}`;
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
