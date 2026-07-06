import { Avatar, HStack, Stack, Text } from "@pawtograder/webapp";

export const Initials = () => (
  <HStack gap="4">
    <Avatar name="Ava Thompson" />
    <Avatar name="Marcus Lee" colorPalette="green" />
    <Avatar name="Priya Nair" colorPalette="purple" />
  </HStack>
);

export const Sizes = () => (
  <HStack gap="4" alignItems="center">
    <Avatar name="Diego Ramirez" size="xs" />
    <Avatar name="Diego Ramirez" size="sm" />
    <Avatar name="Diego Ramirez" size="md" />
    <Avatar name="Diego Ramirez" size="lg" />
  </HStack>
);

export const WithName = () => (
  <HStack gap="3">
    <Avatar name="Professor Bell" colorPalette="blue" />
    <Stack gap="0">
      <Text fontWeight="medium">Professor Bell</Text>
      <Text fontSize="sm" color="fg.muted">
        Instructor · CS 3100
      </Text>
    </Stack>
  </HStack>
);

export const WithImage = () => (
  <HStack gap="4">
    <Avatar name="Sofia Chen" src="https://i.pravatar.cc/150?img=47" />
    <Avatar name="Liam O'Brien" src="https://i.pravatar.cc/150?img=12" />
  </HStack>
);
