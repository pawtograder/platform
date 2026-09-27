import { Box, HStack, Text, VStack } from "@pawtograder/webapp";
import {
  StatusCell,
  AssignmentTitleCell,
  StudentOrGroupLabel,
  AppealGrantedCell
} from "@pawtograder/webapp";

export const AllStatuses = () => (
  <VStack align="start" gap={3} p={4}>
    {(["draft", "opened", "resolved", "escalated", "closed"] as const).map((status) => (
      <HStack key={status} gap={3}>
        <Box minW="120px">
          <Text fontSize="xs" color="fg.muted" fontFamily="mono">
            {status}
          </Text>
        </Box>
        <StatusCell status={status} />
      </HStack>
    ))}
  </VStack>
);

export const TitleCell = () => (
  <Box p={4}>
    <AssignmentTitleCell
      title="Assignment 4: Generic Binary Search Tree"
      href="#assignment-4"
    />
  </Box>
);

export const StudentVsGroup = () => (
  <VStack align="start" gap={2} p={4}>
    <StudentOrGroupLabel profileName="Priya Raman" />
    <StudentOrGroupLabel
      assignmentGroupsMembers={[
        { profiles: { name: "Marcus Webb" } },
        { profiles: { name: "Lena Ortiz" } },
        { profiles: { name: "Tom Becker" } }
      ]}
    />
  </VStack>
);

export const AppealGranted = () => (
  <VStack align="start" gap={2} p={4}>
    <AppealGrantedCell status="closed" closedPoints={12} resolvedPoints={8} />
    <AppealGrantedCell status="closed" closedPoints={8} resolvedPoints={8} />
    <AppealGrantedCell status="opened" closedPoints={null} resolvedPoints={null} />
  </VStack>
);
