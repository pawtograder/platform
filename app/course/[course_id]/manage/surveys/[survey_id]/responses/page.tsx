import { Container, Heading, Text } from "@chakra-ui/react";
import { createClient } from "@/utils/supabase/server";
import SurveyResponsesView from "./SurveyResponsesView";

type SurveyResponsesPageProps = {
  params: Promise<{ course_id: string; survey_id: string }>;
};

export default async function SurveyResponsesPage({ params }: SurveyResponsesPageProps) {
  const { course_id, survey_id } = await params;
  const supabase = await createClient();

  // Fetch survey data to get title, status, version, and JSON (latest version)
  const { data: survey, error: surveyError } = await supabase
    .from("surveys" as any)
    .select("id, title, status, version, json")
    .eq("survey_id", survey_id)
    .eq("class_id", Number(course_id))
    .is("deleted_at", null)
    .order("version", { ascending: false })
    .limit(1)
    .single();

  if (surveyError) {
    console.error("Error fetching survey:", surveyError);
    return (
      <Container py={8} maxW="1200px" my={2}>
        <Heading size="xl" mb={4}>
          Survey Responses
        </Heading>
        <Text>Error loading survey details.</Text>
      </Container>
    );
  }

  if (!survey) {
    return (
      <Container py={8} maxW="1200px" my={2}>
        <Heading size="xl" mb={4}>
          Survey Responses
        </Heading>
        <Text>Survey not found or deleted.</Text>
      </Container>
    );
  }

  // Fetch all responses for this survey_id (across all versions)
  // Join with profiles to get student names and emails
  const { data: responses, error: responsesError } = await supabase
    .from("survey_responses" as any)
    .select(
      `
      *,
      profiles!profile_id (
        name
      )
    `
    )
    .eq("survey_id", (survey as any).id) // Use the database ID of the latest survey version to fetch responses
    .eq("is_submitted", true)
    .is("deleted_at", null);

  if (responsesError) {
    console.error("Error fetching responses:", responsesError);
    return (
      <Container py={8} maxW="1200px" my={2}>
        <Heading size="xl" mb={4}>
          Survey Responses
        </Heading>
        <Text>Error loading survey responses.</Text>
      </Container>
    );
  }

  // Get total enrolled students in the course
  const { count: totalStudents } = await supabase
    .from("user_roles")
    .select("*", { count: "exact", head: true })
    .eq("class_id", Number(course_id))
    .in("role", ["student", "grader", "instructor"]); // Count all roles for now, refine later if needed

  // Pass data to the client component
  return (
    <SurveyResponsesView
      courseId={course_id}
      surveyId={survey_id} // The UUID
      surveyTitle={(survey as any).title}
      surveyVersion={(survey as any).version}
      surveyStatus={(survey as any).status}
      surveyJson={(survey as any).json}
      responses={(responses as any) || []}
      totalStudents={totalStudents || 0}
    />
  );
}
