import { Button, HStack, Stack } from "@pawtograder/webapp";

export const Variants = () => (
  <HStack gap={3} wrap="wrap">
    <Button colorPalette="green">Submit assignment</Button>
    <Button variant="outline">Save draft</Button>
    <Button variant="subtle">Preview rubric</Button>
    <Button variant="ghost">Cancel</Button>
  </HStack>
);

export const Colors = () => (
  <HStack gap={3} wrap="wrap">
    <Button colorPalette="green">Release grades</Button>
    <Button colorPalette="red">Delete submission</Button>
    <Button colorPalette="blue">Open in GitHub</Button>
    <Button colorPalette="orange">Request regrade</Button>
  </HStack>
);

export const Sizes = () => (
  <HStack gap={3} align="center" wrap="wrap">
    <Button size="xs">Extra small</Button>
    <Button size="sm">Small</Button>
    <Button size="md">Medium</Button>
    <Button size="lg">Large</Button>
  </HStack>
);

export const Loading = () => (
  <HStack gap={3} wrap="wrap">
    <Button loading colorPalette="green">
      Grading
    </Button>
    <Button loading loadingText="Running autograder…" colorPalette="blue">
      Run
    </Button>
  </HStack>
);

export const States = () => (
  <HStack gap={3} wrap="wrap">
    <Button>Enabled</Button>
    <Button disabled>Disabled</Button>
    <Button variant="outline" disabled>
      Disabled outline
    </Button>
  </HStack>
);
