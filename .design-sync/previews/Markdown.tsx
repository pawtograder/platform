import { Box, Markdown } from "@pawtograder/webapp";

const richBody = `# Assignment 4: Generic Binary Search Tree

Implement a generic \`BST<T>\` with **insert**, **delete**, and **in-order traversal**.
Your submission will be graded against the hidden autograder suite.

## Requirements

1. \`insert(value)\` must reject duplicate keys
2. \`delete(value)\` must preserve the BST invariant
3. Traversal must run in *O(n)* time

Useful reading: [Effective Java, Item 30](https://example.edu/cs3100/generics).

> **Note:** Submissions that fail to compile receive a score of **0**.
> Run \`mvn test\` locally before pushing.

\`\`\`java
public <T extends Comparable<T>> void insert(T value) {
    root = insertRec(root, value);
}
\`\`\`
`;

export const AssignmentBrief = () => (
  <Box maxW="640px" p={4}>
    <Markdown>{richBody}</Markdown>
  </Box>
);

const tableBody = `### Autograder Results

| Test Case | Status | Points |
| --------- | ------ | -----: |
| \`insertBalanced\` | Passed | 10 / 10 |
| \`deleteLeaf\` | Passed | 8 / 8 |
| \`deleteWithTwoChildren\` | **Failed** | 0 / 12 |
| \`inOrderTraversal\` | Passed | 10 / 10 |

Total: **28 / 40** — see the failing case for a \`NullPointerException\`.
`;

export const FeedbackTable = () => (
  <Box maxW="560px" p={4}>
    <Markdown>{tableBody}</Markdown>
  </Box>
);

const inlineBody = `Reviewer note: your \`compareTo\` looks correct, but consider edge cases.

- Handle the **empty tree** case first
- Avoid recursion deeper than ~1000 frames (stack overflow risk)
- Style: prefer \`final\` fields where possible

You can reach the TA team on the *office hours* queue if blocked.`;

export const ReviewerNote = () => (
  <Box maxW="520px" p={4}>
    <Markdown>{inlineBody}</Markdown>
  </Box>
);
