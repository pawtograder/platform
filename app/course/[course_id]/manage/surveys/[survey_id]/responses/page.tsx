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
    .select("id, title, status, json")
    // .select("id, title, status, version, json") // Temporarily remove version to test
    .eq("survey_id", survey_id)
    .eq("class_id", Number(course_id))
    // .is("deleted_at", null) // Temporarily comment out to test if this column exists
    // .order("version", { ascending: false }) // Temporarily comment out since we're not selecting version
    .limit(1)
    .single();

  if (surveyError) {
    console.error("Error fetching survey:", surveyError);
    console.error("Survey ID from params:", survey_id);
    console.error("Course ID:", course_id);
    return (
      <Container py={8} maxW="1200px" my={2}>
        <Heading size="xl" mb={4}>
          Survey Responses
        </Heading>
        <Text>Error loading survey details.</Text>
        <Text fontSize="sm" color="red.500" mt={2}>
          Error: {surveyError.message}
        </Text>
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
      profiles!student_id (
        name,
        user_roles!user_roles_private_profile_id_fkey (
          users!user_roles_user_id_fkey1 (
            email
          )
        )
      )
    `
    )
    .eq("survey_id", (survey as any).id); // Use the database ID of the latest survey version to fetch responses
  // .eq("is_submitted", true); // Temporarily comment out to test if this column exists
  // .is("deleted_at", null); // Temporarily comment out to test if this column exists

  if (responsesError) {
    console.error("Error fetching responses:", responsesError);
    console.error("Survey ID used for query:", (survey as any).id);
    console.error("Course ID:", course_id);
    return (
      <Container py={8} maxW="1200px" my={2}>
        <Heading size="xl" mb={4}>
          Survey Responses
        </Heading>
        <Text>Error loading survey responses.</Text>
        <Text fontSize="sm" color="red.500" mt={2}>
          Error: {responsesError.message}
        </Text>
      </Container>
    );
  }

  // Get total enrolled students in the course (only students, not instructors/graders)
  const { count: totalStudents } = await supabase
    .from("user_roles")
    .select("*", { count: "exact", head: true })
    .eq("class_id", Number(course_id))
    .eq("role", "student");

  // Pass data to the client component
  return (
    <SurveyResponsesView
      courseId={course_id}
      surveyId={survey_id} // The UUID
      surveyTitle={(survey as any).title}
      surveyVersion={1} // Temporarily hardcode since we're not selecting version
      surveyStatus={(survey as any).status}
      surveyJson={(survey as any).json}
      responses={(responses as any) || []}
      totalStudents={totalStudents || 0}
    />
  );
}
