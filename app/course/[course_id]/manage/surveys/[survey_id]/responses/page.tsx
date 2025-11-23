import { Container, Heading, Text } from "@chakra-ui/react";
import { createClient } from "@/utils/supabase/server";
import SurveyResponsesView from "./SurveyResponsesView";

type SurveyResponsesPageProps = {
  params: Promise<{ course_id: string; survey_id: string }>;
};

export default async function SurveyResponsesPage({ params }: SurveyResponsesPageProps) {
  const { course_id, survey_id } = await params;
  const supabase = await createClient();

  // Fetch survey data to get title, status, version, JSON, due_date, and assignment mode (latest version)
  const { data: survey, error: surveyError } = await supabase
    .from("surveys")
    .select("id, title, status, json, due_date, assigned_to_all")
    .eq("survey_id", survey_id)
    .eq("class_id", Number(course_id))
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
    .from("survey_responses")
    .select(
      `
      *,
      profiles:profiles!profile_id (
        id,
        name
      )
    `
    )
    .eq("survey_id", survey.id);
  // Use the database ID of the latest survey version to fetch responses
  // .eq("is_submitted", true); // Temporarily comment out to test if this column exists
  // .is("deleted_at", null); // Temporarily comment out to test if this column exists

  if (responsesError) {
    console.error("Error fetching responses:", responsesError);
    console.error("Survey ID used for query:", survey.id);
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

  // Calculate the correct total students based on assignment mode
  let assignedStudentCount = 0;
  
  if (survey.assigned_to_all) {
    // Survey is assigned to all students - count all students in the course
    const { count } = await supabase
    .from("user_roles")
    .select("*", { count: "exact", head: true })
    .eq("class_id", Number(course_id))
      .eq("role", "student")
      .eq("disabled", false);
    
    assignedStudentCount = count || 0;
  } else {
    // Survey is assigned to specific students - count assignments
    const { count } = await supabase
      .from("survey_assignments")
      .select("*", { count: "exact", head: true })
      .eq("survey_id", survey.id);
    
    assignedStudentCount = count || 0;
  }

  // Pass data to the client component
  return (
    <SurveyResponsesView
      courseId={course_id}
      surveyId={survey_id} // The UUID
      surveyTitle={survey.title}
      surveyVersion={1} // Temporarily hardcode since we're not selecting version
      surveyStatus={survey.status}
      surveyJson={survey.json}
      surveyDueDate={survey.due_date}
      responses={responses || []}
      totalStudents={assignedStudentCount}
    />
  );
}
