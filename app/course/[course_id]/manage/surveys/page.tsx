"use client";

import { Container, Heading, Box, Text, VStack, Button, Icon } from "@chakra-ui/react";

type ManageSurveysPageProps = {
  params: Promise<{ course_id: string }>;
};

export default async function ManageSurveysPage({ params }: ManageSurveysPageProps) {
  const { course_id } = await params;

  return (
    <Container py={8} maxW="1200px" my={2}>
      <Heading size="2xl" mb={8}>
        Manage Surveys
      </Heading>

      <VStack
        align="center"
        justify="center"
        w="100%"
        h="33vh"
        gap={6}
        bg="#1A1A1A"
        border="1px solid #2D2D2D"
        borderRadius="lg"
        p={12}
        mx="auto"
      >
        <Box textAlign="center">
          <Heading size="lg" mb={3} color="#A0AEC0" fontWeight="bold">
            No surveys yet
          </Heading>
          <Text fontSize="md" color="#718096" mb={8}>
            Create your first survey to gather feedback from students.
          </Text>
          <Button
            colorScheme="green"
            size="xs"
            bg="green.500"
            color="white"
            _hover={{
              bg: "green.600"
            }}
            onClick={() => {
              // TODO: Add routing to create survey page
              console.log("Create survey clicked");
            }}
          >
            + Create Your First Survey
          </Button>
        </Box>
      </VStack>
    </Container>
  );
}
