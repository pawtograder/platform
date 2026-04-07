import { Box, Skeleton, SkeletonText, Stack } from "@chakra-ui/react";

/** Default instant feedback for App Router navigations (matches Chakra page padding patterns). */
export function AppRouteLoadingSkeleton() {
  return (
    <Box px={{ base: 4, md: 6 }} py={6} maxW="1400px" mx="auto" w="100%">
      <Stack gap={4}>
        <Skeleton height="36px" width="min(45%, 360px)" borderRadius="md" />
        <Skeleton height="88px" borderRadius="md" />
        <SkeletonText noOfLines={5} gap={3} />
        <Skeleton height="200px" borderRadius="md" />
      </Stack>
    </Box>
  );
}

/** Compact skeleton for nested segments (assignments, office hours, etc.). */
export function AppNestedRouteLoadingSkeleton() {
  return (
    <Box px={{ base: 3, md: 5 }} py={4}>
      <Stack gap={3}>
        <Skeleton height="28px" width="55%" maxW="280px" borderRadius="md" />
        <Skeleton height="160px" borderRadius="md" />
        <SkeletonText noOfLines={4} gap={3} />
      </Stack>
    </Box>
  );
}

/** Matches admin dashboard grid + two-column layout (lighter than full route skeleton). */
export function AdminDashboardSkeleton() {
  return (
    <Stack gap={6}>
      <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap={4}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} height="100px" borderRadius="md" />
        ))}
      </Box>
      <Box display="grid" gridTemplateColumns={{ base: "1fr", lg: "2fr 1fr" }} gap={4}>
        <Skeleton height="220px" borderRadius="md" />
        <Skeleton height="220px" borderRadius="md" />
      </Box>
    </Stack>
  );
}
