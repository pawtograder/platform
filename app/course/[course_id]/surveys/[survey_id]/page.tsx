// displays survey with this survey ID for a student to fill out

import { Container, Heading, Text, VStack, Box, HStack } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import Link from "@/components/ui/link";
import { FaArrowLeft } from "react-icons/fa";

type SurveyDetailPageProps = {
  params: Promise<{ course_id: string; survey_id: string }>;
};

export default async function SurveyDetailPage({ params }: SurveyDetailPageProps) {
  const { course_id, survey_id } = await params;

  return (
    <Container py={8}>
      <VStack align="stretch" gap={8}>
        {/* Back Button */}
        <HStack>
          <Link href={`/course/${course_id}/surveys`}>
            <Button variant="outline" size="sm">
              <FaArrowLeft />
              Back to Surveys
            </Button>
          </Link>
        </HStack>

        {/* Header */}
        <Box textAlign="center" mb={4}>
          <Heading size="2xl" mb={4}>
            Survey Details
          </Heading>
          <Text fontSize="lg" mx="auto">
            View and complete survey
          </Text>
        </Box>

        {/* Placeholder */}
        <VStack align="center" justify="center" minH="400px" gap={6} borderRadius="2xl" p={12} border="2px dashed">
          <VStack gap={3}>
            <Heading size="lg">Survey Placeholder</Heading>
            <Text fontSize="lg" textAlign="center">
              Survey details and questions
            </Text>
            <Text fontSize="md" textAlign="center" color="gray.500">
              Course ID: {course_id} | Survey ID: {survey_id}
            </Text>
          </VStack>
        </VStack>
      </VStack>
    </Container>
  );
}
