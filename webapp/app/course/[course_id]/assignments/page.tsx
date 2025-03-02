import LinkAccount from "@/components/github/link-account";
import { AssignmentWithRepositoryAndSubmissionsAndGraderResults } from "@/utils/supabase/DatabaseTypes";
import { createClient } from "@/utils/supabase/server";
import { Button, Container, Heading, Table } from "@chakra-ui/react";
import { format, formatDistanceToNowStrict, formatRelative } from "date-fns";
import Link from "@/components/ui/link";
import CreateStudentReposButton from "./createStudentReposButton";
import { fetchCreateGitHubReposForStudent } from "@/lib/generated/pawtograderComponents";
import { revalidatePath } from "next/cache";
import { Alert } from "@/components/ui/alert";
export default async function StudentPage({ params }: { params: Promise<{ course_id: string }> }) {
    const { course_id } = await params;

    const client = await createClient();
    const user = (await client.auth.getUser()).data.user;
    let assignments = await client.from("assignments")
        .select("*, submissions(*, grader_results(*)), repositories(*)")
        .eq("class_id", Number(course_id))
        .eq("repositories.user_id", user!.id)
        .order("due_date", { ascending: false });

    //list identities
    const identities = await client.auth.getUserIdentities();
    const githubIdentity = identities.data?.identities.find((identity) => identity.provider === "github");

    let actions = <></>;
    if (!githubIdentity) {
        actions = <LinkAccount />
    } else {
        const assignmentsWithoutRepos = assignments.data?.filter((assignment) => !assignment.repositories.length);
        const session = await client.auth.getSession();
        if (assignmentsWithoutRepos?.length) {
            console.log("Creating GitHub repos for student");
            const ret = await fetchCreateGitHubReposForStudent({
                headers: {
                    Authorization: `${session.data.session?.access_token}`
                }
            });
            assignments = await client.from("assignments")
                .select("*, submissions(*, grader_results(*)), repositories(*)")
                .eq("class_id", Number(course_id))
                .eq("repositories.user_id", user!.id)
                .order("due_date", { ascending: false });
            actions = <><Alert status="info">GitHub repos created for you. Please refresh the page to see them. IDK why this is needed/Fixme.</Alert></>;
        }
    }
    const getLatestSubmission = (assignment: AssignmentWithRepositoryAndSubmissionsAndGraderResults) => {
        assignment
        return assignment.submissions.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    }
    return (
        <Container>
            {actions}
            <Heading size="lg" mb={4}>Assignments</Heading>
            <Table.Root>
                <Table.Header>
                    <Table.Row>
                        <Table.ColumnHeader>Due Date</Table.ColumnHeader>
                        <Table.ColumnHeader>Name</Table.ColumnHeader>
                        <Table.ColumnHeader>Latest Submission</Table.ColumnHeader>
                        <Table.ColumnHeader>GitHub Repository</Table.ColumnHeader>
                    </Table.Row>
                </Table.Header>
                <Table.Body>
                    {assignments.data?.map((assignment) => {
                        const mostRecentSubmission = getLatestSubmission(assignment);
                        return <Table.Row key={assignment.id}>
                            <Table.Cell><Link prefetch={true} href={`/course/${course_id}/assignments/${assignment.id}/submissions/${mostRecentSubmission?.id}`}>{format(new Date(assignment.due_date!), "MMM d h:mm aaa")}</Link></Table.Cell>
                            <Table.Cell><Link
                                prefetch={true} href={`/course/${course_id}/assignments/${assignment.id}/submissions/${mostRecentSubmission?.id}`}>{assignment.title}</Link></Table.Cell>
                            <Table.Cell>
                                {mostRecentSubmission ? <Link prefetch={true} href={`/course/${course_id}/assignments/${assignment.id}/submissions/${mostRecentSubmission?.id}`}>
                                    #{mostRecentSubmission.ordinal} ({mostRecentSubmission.grader_results?.score || 0}/{mostRecentSubmission.grader_results?.max_score || 0})
                                </Link> : '-'}
                            </Table.Cell>
                            <Table.Cell><Link
                                target="_blank" href={`https://github.com/${assignment.repositories[0]?.repository}`}>{assignment.repositories[0]?.repository}</Link> </Table.Cell>
                        </Table.Row>
                    })}
                </Table.Body>
            </Table.Root>
        </Container>
    );
}