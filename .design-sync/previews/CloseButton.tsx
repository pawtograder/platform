import { CloseButton, HStack, Card, Text, Heading, Box } from "@pawtograder/webapp";

export const Default = () => <CloseButton />;

export const Sizes = () => (
  <HStack gap={3} align="center">
    <CloseButton size="xs" />
    <CloseButton size="sm" />
    <CloseButton size="md" />
    <CloseButton size="lg" />
  </HStack>
);

export const Variants = () => (
  <HStack gap={3} align="center">
    <CloseButton variant="ghost" />
    <CloseButton variant="outline" />
    <CloseButton variant="subtle" />
    <CloseButton colorPalette="red" variant="subtle" />
  </HStack>
);

export const InContext = () => (
  <Card.Root maxW="320px">
    <Card.Body>
      <HStack justify="space-between" align="flex-start">
        <Box>
          <Heading size="sm">Regrade request</Heading>
          <Text fontSize="sm" color="fg.muted">
            Submission #4821 — flagged by student
          </Text>
        </Box>
        <CloseButton size="sm" aria-label="Dismiss" />
      </HStack>
    </Card.Body>
  </Card.Root>
);
