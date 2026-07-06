import { Skeleton, SkeletonText, SkeletonCircle, HStack, Stack, Box } from "@pawtograder/webapp";

export const SubmissionRow = () => (
  <HStack gap="4" width="360px">
    <SkeletonCircle size="10" />
    <Stack flex="1" gap="2">
      <Skeleton height="4" width="60%" />
      <Skeleton height="3" width="40%" />
    </Stack>
    <Skeleton height="6" width="16" />
  </HStack>
);

export const TextLines = () => (
  <Box width="320px">
    <SkeletonText noOfLines={4} gap="3" />
  </Box>
);

export const GradeCard = () => (
  <Stack gap="3" width="280px" p="4" borderWidth="1px" borderRadius="md">
    <Skeleton height="5" width="50%" />
    <SkeletonText noOfLines={2} gap="2" />
    <HStack gap="3">
      <Skeleton height="8" width="20" />
      <Skeleton height="8" width="20" />
    </HStack>
  </Stack>
);

export const Blocks = () => (
  <HStack gap="3">
    <Skeleton height="20" width="20" />
    <Skeleton height="20" width="20" />
    <Skeleton height="20" width="20" />
  </HStack>
);
