import { ActiveSubmissionIcon, HStack, Text } from "@pawtograder/webapp";

export const Default = () => (
  <HStack gap={2}>
    <ActiveSubmissionIcon />
    <Text fontSize="sm">Submission #7 (active)</Text>
  </HStack>
);

export const InRow = () => (
  <HStack gap={2} fontSize="sm">
    <Text fontWeight="medium">commit a1b9f2c</Text>
    <ActiveSubmissionIcon />
    <Text color="fg.muted">Add binary-search edge cases</Text>
  </HStack>
);
