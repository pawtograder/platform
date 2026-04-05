import { Box, Skeleton, SkeletonText, Stack } from "@chakra-ui/react";

export default function ManageSegmentLoading() {
  return (
    <Box px={{ base: 3, md: 6 }} py={4}>
      <Stack gap={4}>
        <Skeleton height="36px" width="220px" borderRadius="md" />
        <Skeleton height="240px" borderRadius="md" />
        <SkeletonText noOfLines={6} gap={3} />
      </Stack>
    </Box>
  );
}
