import type { Survey } from "@/types/survey";
import { createClient } from "@/utils/supabase/server";
import { Container } from "@chakra-ui/react";
import EmptySurveysState from "./EmptySurveysState";
import SurveysHeader from "./SurveysHeader";
import SurveysTable from "./SurveysTable";

type ManageSurveysPageProps = {
  params: Promise<{ course_id: string }>;
};

export default async function ManageSurveysPage({ params }: ManageSurveysPageProps) {
  const { course_id } = await params;
  const supabase = await createClient();

  // Fetch surveys for this course (excluding soft-deleted)
  const { data: surveys, error } = await supabase
    .from("surveys")
    .select("*")
    .eq("class_id", Number(course_id))
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error fetching surveys:", error);
  }

  // Get total enrolled students in the course (used for surveys assigned to all)
  const { count: totalStudents } = await supabase
    .from("user_roles")
    .select("*", { count: "exact", head: true })
    .eq("class_id", Number(course_id))
    .eq("role", "student")
    .eq("disabled", false);

  // Fetch response counts and assigned student counts for each survey
  const surveysWithCounts = await Promise.all(
    (surveys || []).map(async (survey: Survey) => {
      // Get response count
      const { count: responseCount } = await supabase
        .from("survey_responses")
        .select("*", { count: "exact", head: true })
        .eq("survey_id", survey.id)
        .eq("is_submitted", true)
        .is("deleted_at", null);

      // Calculate assigned student count based on assignment mode
      let assignedStudentCount = totalStudents || 0;

      if (!survey.assigned_to_all) {
        // Survey is assigned to specific students - count assignments
        const { count: assignmentCount } = await supabase
          .from("survey_assignments")
          .select("*", { count: "exact", head: true })
          .eq("survey_id", survey.id);

        assignedStudentCount = assignmentCount || 0;
      }

      return {
        ...survey,
        response_count: responseCount || 0,
        submitted_count: responseCount || 0,
        assigned_student_count: assignedStudentCount
      };
    })
  );

  // Show empty state if no surveys
  if (!surveys || surveys.length === 0) {
    return <EmptySurveysState courseId={course_id} />;
  }

  // Show table with surveys
  return (
    <Container py={8} maxW="1200px" my={2}>
      <SurveysHeader courseId={course_id} />

      <SurveysTable surveys={surveysWithCounts} courseId={course_id} />
    </Container>
  );
}
