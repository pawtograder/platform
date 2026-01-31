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

## MCP Tools Available

Use the Pawtograder MCP server to fetch additional context:

1. **Get assignment spec/handout**:
   \`\`\`json
   {"tool": "get_assignment", "params": {"assignment_id": ${assignmentId}, "class_id": ${classId}}}
   \`\`\`

2. **Get submission with full test output** (sample affected submissions):
${submissionIds
  .slice(0, 3)
  .map(
    (id) =>
      `   \`\`\`json
   {"tool": "get_submission", "params": {"submission_id": ${id}, "class_id": ${classId}, "include_test_output": true}}
   \`\`\``
  )
  .join("\n")}

## Your Task

Analyze this error pattern and provide TWO things:

### 1. Assignment/Test Issue Assessment

Determine if this error pattern suggests a problem with the assignment itself:
- Does the test contradict the assignment specification?
- Is the test checking for behavior not described in the handout?
- Are error messages unclear or misleading?
- Is the expected behavior ambiguous in the spec?

If you identify a potential assignment issue, explain what needs to be fixed (test logic, spec clarification, etc.).

If the test appears correct and students are genuinely making mistakes, say so clearly.

### 2. Discussion Post for Students (Ready to Copy/Paste)

If this is a student error (not an assignment bug), draft a discussion post in markdown that the instructor can pin to help affected students. The post should:

- Have a clear, descriptive title
- Explain the common mistake WITHOUT giving away the solution
- Provide hints and debugging strategies
- Reference relevant concepts from the assignment
- Be encouraging and educational

Format the discussion post like this:

---
**DISCUSSION POST (copy below this line):**

# [Title Here]

[Post content in markdown...]

---

Remember: Never reveal the complete solution. Guide students toward understanding their mistake.`;

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
