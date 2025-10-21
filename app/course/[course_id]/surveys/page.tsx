// lists all surveys for this course ID
// students (and maybe TAs) see this page

"use client";

import { Container, Heading, Text, VStack, Box } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";

type SurveysPageProps = {
  params: Promise<{ course_id: string }>;
};

export default function SurveysPage({ params }: SurveysPageProps) {
  // Color mode values - same as the manage surveys empty state
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const headingColor = useColorModeValue("#4B5563", "#A0AEC0");
  const descriptionColor = useColorModeValue("#6B7280", "#718096");

  return (
    <Container py={8} maxW="1200px" my={2}>
      <Heading size="2xl" mb={8} color={textColor}>
        Surveys
      </Heading>

      <VStack
        align="center"
        justify="center"
        w="100%"
        h="33vh"
        gap={6}
        bg={cardBgColor}
        border="1px solid"
        borderColor={borderColor}
        borderRadius="lg"
        p={12}
        mx="auto"
        minH="300px"
      >
        <Box textAlign="center">
          <Heading size="lg" mb={3} color={headingColor} fontWeight="bold">
            No surveys available yet
          </Heading>
          <Text fontSize="md" color={descriptionColor} mb={8}>
            Your instructor hasn't posted any surveys. Check back later!
          </Text>
        </Box>
      </VStack>
    </Container>
  );
}
