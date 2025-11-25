"use client";

import { useSearchParams, useRouter, useParams } from "next/navigation";
import { Suspense, useCallback } from "react";
import { Box, Button, Heading, VStack, Text } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import dynamic from "next/dynamic";
import type { SurveyModel, Question } from "survey-core";

const SurveyComponent = dynamic(() => import("@/components/Survey"), {
  ssr: false,
  loading: () => (
    <Box display="flex" alignItems="center" justifyContent="center" p={8}>
      <Text>Loading survey preview...</Text>
    </Box>
  )
});

function SurveyPreviewContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { course_id } = useParams();

  // Color mode values
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const buttonTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const buttonBorderColor = useColorModeValue("#6B7280", "#4A5568");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");

  const surveyJsonParam = searchParams.get("json");

  const handleBackToForm = useCallback(() => {
    router.push(`/course/${course_id}/manage/surveys/new?from=preview`);
  }, [router, course_id]);

  if (!surveyJsonParam) {
    return (
      <VStack align="center" gap={6} w="100%" minH="100vh" p={8}>
        <Box
          w="100%"
          maxW="800px"
          bg={cardBgColor}
          border="1px solid"
          borderColor={borderColor}
          borderRadius="lg"
          p={8}
        >
          <VStack align="center" gap={4}>
            <Heading size="xl" color={textColor} textAlign="center">
              No Survey Data
            </Heading>
            <Text color={textColor} textAlign="center">
              Please provide survey JSON data to display the survey preview.
            </Text>
            <Button
              variant="outline"
              bg="transparent"
              borderColor={buttonBorderColor}
              color={buttonTextColor}
              _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
              onClick={handleBackToForm}
            >
              ← Back to Survey Form
            </Button>
          </VStack>
        </Box>
      </VStack>
    );
  }

  let surveyJson;
  try {
    surveyJson = JSON.parse(decodeURIComponent(surveyJsonParam));
  } catch {
    return (
      <VStack align="center" gap={6} w="100%" minH="100vh" p={8}>
        <Box
          w="100%"
          maxW="800px"
          bg={cardBgColor}
          border="1px solid"
          borderColor={borderColor}
          borderRadius="lg"
          p={8}
        >
          <VStack align="center" gap={4}>
            <Heading size="xl" color={textColor} textAlign="center">
              Invalid Survey Data
            </Heading>
            <Text color="red.500" textAlign="center">
              The provided survey JSON is invalid. Please check your JSON configuration.
            </Text>
            <Button
              variant="outline"
              bg="transparent"
              borderColor={buttonBorderColor}
              color={buttonTextColor}
              _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
              onClick={handleBackToForm}
            >
              ← Back to Survey Form
            </Button>
          </VStack>
        </Box>
      </VStack>
    );
  }

  const handleComplete = (survey: SurveyModel) => {
    console.log("Survey completed:", survey.data);
    // survey.data is a Record<string, any> containing all answers
  };

  const handleValueChanged = (survey: SurveyModel, options: { name: string; question: Question; value: unknown }) => {
    console.log("Survey value changed:", options.name, options.value);
    // options.value is unknown because it depends on the question type
  };

  return (
    <VStack align="center" gap={6} w="100%" minH="100vh" p={8}>
      {/* Header with navigation */}
      <VStack align="stretch" gap={4} w="100%" maxW="1000px">
        <Box display="flex" gap={4} alignSelf="flex-start">
          <Button
            variant="outline"
            size="sm"
            bg="transparent"
            borderColor={buttonBorderColor}
            color={buttonTextColor}
            _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
            onClick={handleBackToForm}
          >
            ← Back to Form
          </Button>
        </Box>

        <Heading size="xl" color={textColor} textAlign="left">
          Survey Preview
        </Heading>
        <Text color={textColor} fontSize="sm" opacity={0.8}>
          This is how your survey will appear to students. You can interact with it to test the functionality.
        </Text>
      </VStack>

      {/* Survey Preview */}
      <Box w="100%" maxW="1000px" bg={cardBgColor} border="1px solid" borderColor={borderColor} borderRadius="lg" p={8}>
        <SurveyComponent surveyJson={surveyJson} onComplete={handleComplete} onValueChanged={handleValueChanged} />
      </Box>
    </VStack>
  );
}

export default function SurveyPreviewPage() {
  return (
    <Suspense
      fallback={
        <VStack align="center" gap={6} w="100%" minH="100vh" p={8}>
          <Box display="flex" alignItems="center" justifyContent="center" p={8}>
            <Text>Loading survey preview...</Text>
          </Box>
        </VStack>
      }
    >
      <SurveyPreviewContent />
    </Suspense>
  );
}
