import SubmissionChecksPage from "@/app/course/[course_id]/assignments/[assignment_id]/submissions/[submissions_id]/checks/page";

export const metadata = {
  title: "Checks"
};

export default function GradeChecksView() {
  return <SubmissionChecksPage />;
}
