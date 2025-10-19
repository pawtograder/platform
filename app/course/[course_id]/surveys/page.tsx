// lists all surveys for this course ID
// students (and maybe TAs) see this page

import { Container, Heading, Text, VStack, Box } from "@chakra-ui/react";

type SurveysPageProps = {
  params: Promise<{ course_id: string }>;
};

export default async function SurveysPage({ params }: SurveysPageProps) {
  const { course_id } = await params;

  return (
    <Container py={8} maxW="1200px" my={2}>
      <Heading size="2xl" mb={8}>
        Surveys
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
        minH="300px"
      >
        <Box textAlign="center">
          <Heading size="lg" mb={3} color="#A0AEC0" fontWeight="bold">
            No surveys available yet
          </Heading>
          <Text fontSize="md" color="#718096" mb={8}>
            Your instructor hasn't posted any surveys. Check back later!
          </Text>
        </Box>
      </VStack>
    </Container>
  );
}
