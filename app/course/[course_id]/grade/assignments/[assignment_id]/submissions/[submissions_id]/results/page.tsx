import GraderResults from "@/app/course/[course_id]/assignments/[assignment_id]/submissions/[submissions_id]/results/page";

export const metadata = {
  title: "Test Results"
};

export default function GradeResultsView() {
  return <GraderResults />;
}
