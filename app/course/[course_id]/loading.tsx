import { Box, Skeleton, SkeletonText, Stack } from "@chakra-ui/react";

export default function CourseSegmentLoading() {
  return (
    <Box px={{ base: 3, md: 6 }} py={4} maxW="1200px" mx="auto">
      <Stack gap={4}>
        <Skeleton height="32px" width="40%" maxW="280px" borderRadius="md" />
        <Skeleton height="120px" borderRadius="md" />
        <SkeletonText noOfLines={4} gap={3} />
        <Skeleton height="200px" borderRadius="md" />
      </Stack>
    </Box>
  );
}
