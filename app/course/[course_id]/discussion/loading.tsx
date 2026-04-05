import { Box, Skeleton, Stack } from "@chakra-ui/react";

export default function DiscussionSegmentLoading() {
  return (
    <Box px={{ base: 3, md: 6 }} py={4}>
      <Stack gap={3}>
        <Skeleton height="40px" borderRadius="md" />
        <Skeleton height="56px" borderRadius="md" />
        <Skeleton height="320px" borderRadius="md" />
      </Stack>
    </Box>
  );
}
