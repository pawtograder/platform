"use client";

import { AIHelpFeedbackPanel } from "@/components/ai-help/AIHelpFeedbackPanel";
import { toaster } from "@/components/ui/toaster";
import { Tooltip } from "@/components/ui/tooltip";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { Button, Icon } from "@chakra-ui/react";
import { useCallback, useState } from "react";
import { BsRobot } from "react-icons/bs";
import type { CommonErrorGroup } from "./types";

interface AIHelpTestErrorButtonProps {
  /** The error group to analyze */
  errorGroup: CommonErrorGroup;
  /** Assignment ID for context */
  assignmentId: number;
  /** Class ID for MCP authorization */
  classId: number;
  /** Button size variant */
  size?: "xs" | "sm" | "md";
  /** Button style variant */
  variant?: "solid" | "outline" | "ghost";
}

/**
 * Generates an AI prompt for analyzing a common test error pattern
 */
function generateTestErrorPrompt(errorGroup: CommonErrorGroup, assignmentId: number, classId: number): string {
  const submissionIds = errorGroup.affected_submission_ids.slice(0, 10); // Limit to first 10

  const prompt = `You are helping an instructor analyze a common test error pattern affecting ${errorGroup.occurrence_count} student submissions.

## Available MCP Tools

Use the Pawtograder MCP server to auto-fetch context. **On your first reply, fetch relevant data for a detailed diagnosis.**

### Assignment Context:
- **get_assignment** - Get assignment spec, handout URL, rubric (essential to verify if test matches spec)

### Submission & Code Tools (use to compare multiple students' approaches):
- **get_submission** - Get submission metadata
- **list_submission_files** - See what files a student submitted
- **get_submission_files** - Fetch specific source files (glob patterns: "*.java", "src/**/*.py")
- **search_submissions** - Search across submissions for patterns

### Test & Build Tools:
- **list_submission_tests** - See all test results for a submission
- **get_test_output** - Get detailed output for a specific test
- **get_submission_build_output** - Get compilation errors

### Search Tools:
- **search_discussion_threads** - Find related questions/discussions

## Starting Context

Use these IDs when calling MCP tools:
- **Assignment ID**: ${assignmentId}
- **Class ID**: ${classId}

## Error Pattern Summary

- **Test Name**: ${errorGroup.test_name}${errorGroup.test_part ? ` (Part: ${errorGroup.test_part})` : ""}
- **Error Signature**: ${errorGroup.error_signature}
- **Affected Submissions**: ${errorGroup.occurrence_count} students
- **Average Score**: ${errorGroup.avg_score}
- **Status**: ${errorGroup.is_failing ? "Failing" : "Partial credit"}

## Sample Error Outputs

${errorGroup.sample_outputs
  .slice(0, 3)
  .map(
    (output, i) =>
      `### Sample ${i + 1}\n\`\`\`\n${output.slice(0, 2000)}${output.length > 2000 ? "\n... (truncated)" : ""}\n\`\`\``
  )
  .join("\n\n")}

## Sample Submission IDs for Deeper Analysis

${submissionIds
  .slice(0, 5)
  .map((id) => `- Submission ${id}`)
  .join("\n")}

## Your Task

**First, fetch:**
1. The assignment spec to verify what behavior is expected
2. Source files from 2-3 affected submissions to see the common mistake
3. The full test output to understand exactly what's being checked

Then provide your analysis:

### 1. Diagnosis with Evidence

Cite **direct evidence** from:
- The assignment specification (quote the relevant section)
- Student code patterns (show snippets from multiple submissions)
- Test output (what's expected vs what students produce)

Example:
> **Evidence**: The spec states "sort in ascending order" (Section 2.3), but the test expects descending. OR: 15 of 20 submissions have \`if (x > 0)\` instead of \`if (x >= 0)\`, suggesting students misread "non-negative" as "positive".

**Verification**: The instructor should cross-check your diagnosis against the spec and student code before acting.

### 2. Assignment/Test Issue Assessment

Determine if this pattern suggests a problem with the assignment:
- Does the test contradict the assignment specification?
- Is the test checking for behavior not described in the handout?
- Are error messages unclear or misleading?
- Is the expected behavior ambiguous in the spec?

If you identify an assignment issue, explain what needs to be fixed.
If students are genuinely making mistakes, say so clearly.

### 3. Discussion Post for Students (Ready to Copy/Paste)

If this is a student error (not an assignment bug), draft TWO versions:

**Version A (Socratic/Exploratory):**
For students just encountering the issue - asks guiding questions, encourages debugging.

**Version B (Direct/Efficient):**
For students who've been stuck a while - clear explanation with concrete next steps.

Format:
---
**DISCUSSION POST - Version A (Socratic):**

# [Title Here]

[Post content...]

---
**DISCUSSION POST - Version B (Direct):**

# [Title Here]

[Post content...]

---

**After using this AI help, please provide feedback in Pawtograder** on whether the analysis was accurate. This helps improve AI assistance for the course.`;

  return prompt;
}

/**
 * Button component to get AI assistance for analyzing a common test error pattern.
 * Shows feedback panel after copying prompt.
 */
export function AIHelpTestErrorButton({
  errorGroup,
  assignmentId,
  classId,
  size = "sm",
  variant = "outline"
}: AIHelpTestErrorButtonProps) {
  const isInstructorOrGrader = useIsGraderOrInstructor();
  const [showFeedback, setShowFeedback] = useState(false);

  const handleCopy = useCallback(async () => {
    const prompt = generateTestErrorPrompt(errorGroup, assignmentId, classId);

    try {
      await navigator.clipboard.writeText(prompt);
      toaster.success({
        title: "Copied AI context",
        description: `Error pattern analysis prompt copied for ${errorGroup.occurrence_count} submissions.`
      });
      // Show feedback panel after copying
      setShowFeedback(true);
    } catch {
      toaster.error({
        title: "Failed to copy",
        description: "Could not copy to clipboard. Please try again."
      });
    }
  }, [errorGroup, assignmentId, classId]);

  // Only show for instructors/graders
  if (!isInstructorOrGrader) {
    return null;
  }

  // Show feedback panel after copying
  if (showFeedback) {
    return (
      <AIHelpFeedbackPanel
        classId={classId}
        contextType="test_insights"
        resourceId={assignmentId}
        onClose={() => setShowFeedback(false)}
      />
    );
  }

  return (
    <Tooltip content="Copy AI prompt for analyzing this error pattern" showArrow>
      <Button
        size={size}
        variant={variant}
        colorPalette="purple"
        onClick={handleCopy}
        aria-label={size === "xs" ? "AI Analyze error pattern" : undefined}
      >
        <Icon as={BsRobot} mr={size === "xs" ? 0 : 1} />
        {size !== "xs" && "AI Analyze"}
      </Button>
    </Tooltip>
  );
}

export default AIHelpTestErrorButton;
