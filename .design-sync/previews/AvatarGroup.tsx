import { Avatar, AvatarGroup, Stack, Text } from "@pawtograder/webapp";

export const ProjectTeam = () => (
  <AvatarGroup>
    <Avatar name="Ava Thompson" />
    <Avatar name="Marcus Lee" />
    <Avatar name="Priya Nair" />
    <Avatar name="Diego Ramirez" />
  </AvatarGroup>
);

export const WithOverflow = () => (
  <AvatarGroup>
    <Avatar name="Sofia Chen" />
    <Avatar name="Liam O'Brien" />
    <Avatar name="Jordan Park" />
    <Avatar name="+5" />
  </AvatarGroup>
);

export const Small = () => (
  <Stack gap="2">
    <Text fontSize="sm" color="fg.muted">
      Graders on this submission
    </Text>
    <AvatarGroup size="sm">
      <Avatar name="Hannah Wu" colorPalette="green" />
      <Avatar name="Tariq Hassan" colorPalette="blue" />
      <Avatar name="Elena Petrov" colorPalette="purple" />
    </AvatarGroup>
  </Stack>
);
