import { PageContainer, Box, Heading, Text, Stack } from "@pawtograder/webapp";

export const Default = () => (
  <Box bg="bg.muted" w="100%">
    <PageContainer>
      <Box borderWidth="1px" borderColor="border.subtle" borderRadius="md" bg="bg.panel" p={4}>
        <Stack gap={1}>
          <Heading size="md">Assignment 4 — Hash Maps</Heading>
          <Text color="fg.muted" fontSize="sm">
            Standard student-facing page container with responsive side gutters.
          </Text>
        </Stack>
      </Box>
    </PageContainer>
  </Box>
);

export const NarrowMaxW = () => (
  <Box bg="bg.muted" w="100%">
    <PageContainer maxW="container.sm">
      <Box borderWidth="1px" borderColor="border.subtle" borderRadius="md" bg="bg.panel" p={4}>
        <Text fontSize="sm">Constrained to container.sm — used for focused forms like regrade requests.</Text>
      </Box>
    </PageContainer>
  </Box>
);
