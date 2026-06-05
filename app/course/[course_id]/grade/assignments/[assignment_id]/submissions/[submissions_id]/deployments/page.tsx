import SubmissionDeploymentsPage from "@/app/course/[course_id]/assignments/[assignment_id]/submissions/[submissions_id]/deployments/page";

export const metadata = {
  title: "Deployments"
};

export default function GradeDeploymentsView() {
  return <SubmissionDeploymentsPage />;
}
