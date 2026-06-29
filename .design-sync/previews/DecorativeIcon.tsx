import { DecorativeIcon, Button, HStack, Stack } from "@pawtograder/webapp";
import { LuDownload, LuGitBranch, LuCircleCheck, LuTriangleAlert } from "react-icons/lu";

export const InButtons = () => (
  <HStack gap={3} wrap="wrap">
    <Button size="sm" colorPalette="blue">
      <DecorativeIcon as={LuDownload} />
      Download submission
    </Button>
    <Button size="sm" variant="outline">
      <DecorativeIcon as={LuGitBranch} />
      View on GitHub
    </Button>
  </HStack>
);

export const Sizes = () => (
  <HStack gap={4} align="center">
    <DecorativeIcon as={LuCircleCheck} boxSize={4} color="green.fg" />
    <DecorativeIcon as={LuCircleCheck} boxSize={6} color="green.fg" />
    <DecorativeIcon as={LuTriangleAlert} boxSize={8} color="orange.fg" />
  </HStack>
);

export const Colors = () => (
  <Stack gap={2}>
    <HStack gap={3}>
      <DecorativeIcon as={LuCircleCheck} color="green.fg" />
      <DecorativeIcon as={LuTriangleAlert} color="orange.fg" />
      <DecorativeIcon as={LuGitBranch} color="blue.fg" />
    </HStack>
  </Stack>
);
