"use client";

import { toaster } from "@/components/ui/toaster";
import { Tooltip } from "@/components/ui/tooltip";
import { Button, Icon } from "@chakra-ui/react";
import { useCallback } from "react";
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

  const mcpContext = {
    mcp_server: "pawtograder",
    version: "0.1.0",
    context_type: "test_error_pattern",
    class_id: classId,
    assignment_id: assignmentId,
    error_pattern: {
      test_name: errorGroup.test_name,
      test_part: errorGroup.test_part,
      error_signature: errorGroup.error_signature,
      occurrence_count: errorGroup.occurrence_count,
      affected_submission_count: errorGroup.affected_submission_ids.length,
      avg_score: errorGroup.avg_score,
      is_failing: errorGroup.is_failing
    },
    sample_outputs: errorGroup.sample_outputs.slice(0, 3) // Include up to 3 samples
  };

  const prompt = `You are helping an instructor analyze a common test error pattern that is affecting multiple student submissions.

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

## MCP Context (for fetching additional data)

\`\`\`json
${JSON.stringify(mcpContext, null, 2)}
\`\`\`

## Suggested Actions

To get more context, use the Pawtograder MCP server with these tools:

1. **Get assignment details**:
   \`\`\`json
   {"tool": "get_assignment", "params": {"assignment_id": ${assignmentId}, "class_id": ${classId}}}
   \`\`\`

2. **Get specific submission details** (for any of these affected submissions):
${submissionIds
  .slice(0, 5)
  .map(
    (id) =>
      `   \`\`\`json
   {"tool": "get_submission", "params": {"submission_id": ${id}, "class_id": ${classId}, "include_test_output": true}}
   \`\`\``
  )
  .join("\n\n")}

## Your Task

Analyze this common error pattern and provide:

1. **Root Cause Analysis**: What is likely causing this error? Look for patterns in the error output.

2. **Common Misconceptions**: What programming concept might students be misunderstanding?

3. **Suggested Guidance**: What hints or explanations would help students fix this issue WITHOUT giving away the solution?

4. **Discussion Post Draft**: If helpful, draft a discussion post that could be pinned to help all affected students.

5. **Additional Data Needed**: If you need more context, specify which MCP tools to call and why.

Remember: Help the instructor understand the pattern and guide students toward the solution, but avoid revealing the complete answer.`;

  return prompt;
}

/**
 * Button component to get AI assistance for analyzing a common test error pattern
 */
export function AIHelpTestErrorButton({
  errorGroup,
  assignmentId,
  classId,
  size = "sm",
  variant = "outline"
}: AIHelpTestErrorButtonProps) {
  const handleCopy = useCallback(async () => {
    const prompt = generateTestErrorPrompt(errorGroup, assignmentId, classId);

    try {
      await navigator.clipboard.writeText(prompt);
      toaster.success({
        title: "Copied AI context",
        description: `Error pattern analysis prompt copied for ${errorGroup.occurrence_count} submissions.`
      });
    } catch {
      toaster.error({
        title: "Failed to copy",
        description: "Could not copy to clipboard. Please try again."
      });
    }
  }, [errorGroup, assignmentId, classId]);

  return (
    <Tooltip content="Copy AI prompt for analyzing this error pattern" showArrow>
      <Button size={size} variant={variant} colorPalette="purple" onClick={handleCopy}>
        <Icon as={BsRobot} mr={size === "xs" ? 0 : 1} />
        {size !== "xs" && "AI Analyze"}
      </Button>
    </Tooltip>
  );
}

export default AIHelpTestErrorButton;
