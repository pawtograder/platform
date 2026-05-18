import SubmissionRepoAnalyticsPage from "@/app/course/[course_id]/assignments/[assignment_id]/submissions/[submissions_id]/repo-analytics/page";

export const metadata = {
  title: "Repository Analytics"
};

export default function GradeRepoAnalyticsView() {
  return <SubmissionRepoAnalyticsPage />;
}
