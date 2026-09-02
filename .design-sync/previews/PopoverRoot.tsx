import {
  PopoverRoot,
  PopoverContent,
  PopoverHeader,
  PopoverBody,
  PopoverTitle,
  PopoverArrow,
  PopoverTrigger,
  Button,
  Stack,
  HStack,
  Text,
  Badge,
  Separator
} from "@pawtograder/webapp";

export const AutograderScorePopover = () => (
  <PopoverRoot open positioning={{ placement: "bottom" }}>
    <PopoverTrigger asChild>
      <Button variant="outline" size="sm">
        92 / 100
      </Button>
    </PopoverTrigger>
    <PopoverContent portalled={false}>
      <PopoverArrow />
      <PopoverHeader>
        <PopoverTitle fontWeight="semibold">Autograder breakdown</PopoverTitle>
      </PopoverHeader>
      <PopoverBody>
        <Stack gap={2}>
          <HStack justify="space-between">
            <Text fontSize="sm">Unit tests</Text>
            <Badge colorPalette="green">48 / 50</Badge>
          </HStack>
          <HStack justify="space-between">
            <Text fontSize="sm">Linting</Text>
            <Badge colorPalette="green">20 / 20</Badge>
          </HStack>
          <HStack justify="space-between">
            <Text fontSize="sm">Code coverage</Text>
            <Badge colorPalette="orange">24 / 30</Badge>
          </HStack>
          <Separator />
          <Text fontSize="xs" color="fg.muted">
            Ran against commit a3f91c2 · 3 minutes ago
          </Text>
        </Stack>
      </PopoverBody>
    </PopoverContent>
  </PopoverRoot>
);

export const GroupMembersPopover = () => (
  <PopoverRoot open positioning={{ placement: "bottom" }}>
    <PopoverTrigger asChild>
      <Button variant="outline" size="sm">
        Group 12 · 3 members
      </Button>
    </PopoverTrigger>
    <PopoverContent portalled={false}>
      <PopoverArrow />
      <PopoverHeader>
        <PopoverTitle fontWeight="semibold">Group 12</PopoverTitle>
      </PopoverHeader>
      <PopoverBody>
        <Stack gap={2}>
          <Text fontSize="sm">Maya Okonkwo (leader)</Text>
          <Text fontSize="sm">Daniel Reyes</Text>
          <Text fontSize="sm">Wei Chen</Text>
          <Separator />
          <Text fontSize="xs" color="fg.muted">
            Repo: pawtograder/ps5-group-12
          </Text>
        </Stack>
      </PopoverBody>
    </PopoverContent>
  </PopoverRoot>
);
