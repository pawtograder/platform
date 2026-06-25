import {
  AppRouteLoadingSkeleton,
  AppNestedRouteLoadingSkeleton,
  AdminDashboardSkeleton,
  Box,
  Text
} from "@pawtograder/webapp";

export const FullRoute = () => (
  <Box w="100%">
    <Text fontSize="xs" color="fg.muted" mb={2}>
      Default App Router navigation skeleton
    </Text>
    <AppRouteLoadingSkeleton />
  </Box>
);

export const NestedRoute = () => (
  <Box w="100%">
    <Text fontSize="xs" color="fg.muted" mb={2}>
      Nested segment (assignment / office hours)
    </Text>
    <AppNestedRouteLoadingSkeleton />
  </Box>
);

export const AdminDashboard = () => (
  <Box w="100%">
    <Text fontSize="xs" color="fg.muted" mb={2}>
      Admin dashboard grid layout
    </Text>
    <AdminDashboardSkeleton />
  </Box>
);
