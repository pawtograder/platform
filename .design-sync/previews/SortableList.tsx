import { Box, HStack, Text, Badge } from "@pawtograder/webapp";
import { SortableList } from "@pawtograder/webapp";

const checks = [
  { id: 1, ordinal: 0, name: "All insert tests pass", points: 15 },
  { id: 2, ordinal: 1, name: "Delete handles all three cases", points: 25 },
  { id: 3, ordinal: 2, name: "Handles empty tree", points: 10 }
];

export const ReorderableChecks = () => (
  <Box maxW="640px">
    <SortableList
      items={checks}
      onReorder={() => {}}
      getItemId={(item) => item.id}
      renderItem={(item) => (
        <HStack
          justify="space-between"
          borderWidth="1px"
          borderRadius="md"
          px={3}
          py={2}
          bg="bg.subtle"
        >
          <Text fontWeight="medium">{item.name}</Text>
          <Badge colorPalette="green">{item.points} pts</Badge>
        </HStack>
      )}
    />
  </Box>
);
