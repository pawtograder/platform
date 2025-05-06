import { ActiveSubmissionIcon } from "@/components/ui/active-submission-icon";
import { createClient } from "@/utils/supabase/server";

export default async function SubmissionsListing({
  params
}: {
  params: Promise<{ course_id: string; assignment_id: string }>;
}) {
  const client = await createClient();
  const { assignment_id } = await params;
  const { data: submissions } = await client
    .from("submissions")
    .select("*, assignments(*)")
    .eq("assignment_id", Number.parseInt(assignment_id));
  if (!submissions) {
    return <div>No submissions found</div>;
  }
  return (
    <div>
      <h1>Submissions for {submissions[0].assignments.title}</h1>
      <ul>
        {submissions.map((submission) => (
          <li key={submission.id}>
            {submission.is_active ? <ActiveSubmissionIcon /> : ""}
            {submission.id}
          </li>
        ))}
      </ul>
    </div>
  );
}
