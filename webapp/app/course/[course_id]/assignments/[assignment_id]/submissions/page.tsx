import { createClient } from "@/utils/supabase/server";

export default async function SubmissionsListing({ params }: { params: Promise<{ course_id: string, assignment_id: string }> }) {
    const client = await createClient();
    const { course_id, assignment_id } = await params;
    const { data: submissions } = await client.from("submissions").select("*, assignments(*)").eq("assignment_id", Number.parseInt(assignment_id));
    if (!submissions) {
        return <div>No submissions found</div>
    }
    return <div style={{ height: "calc(100vh - var(--nav-height))", overflowY: "auto" }}>
        <h1>Submissions for {submissions[0].assignments.title}</h1>
        <ul>
            {submissions.map((submission) => (
                <li key={submission.id}>{submission.id}</li>
            ))}
        </ul>
    </div>

}