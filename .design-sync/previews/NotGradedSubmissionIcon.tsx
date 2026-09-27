import { NotGradedSubmissionIcon, HStack, Text } from "@pawtograder/webapp";

export const Default = () => (
  <HStack gap={2}>
    <NotGradedSubmissionIcon />
    <Text fontSize="sm">Marked #NOT-GRADED</Text>
  </HStack>
);

export const InRow = () => (
  <HStack gap={2} fontSize="sm">
    <Text fontWeight="medium">commit 3d77e10</Text>
    <NotGradedSubmissionIcon />
    <Text color="fg.muted">WIP: refactor parser (do not grade)</Text>
  </HStack>
);
