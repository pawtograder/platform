import LinkAccount from "@/components/github/link-account";
import { Alert } from "@/components/ui/alert";
import { AssignmentDueDate } from "@/components/ui/assignment-due-date";
import Link from "@/components/ui/link";
import { autograderCreateReposForStudent } from "@/lib/edgeFunctions";
import {
  AssignmentGroup,
  AssignmentGroupMember,
  AssignmentWithRepositoryAndSubmissionsAndGraderResults,
  Repo
} from "@/utils/supabase/DatabaseTypes";
import { createClient } from "@/utils/supabase/server";
import { Container, Heading, Table, Text } from "@chakra-ui/react";
import { PostgrestError } from "@supabase/supabase-js";

// Define the type for the groups query result
type AssignmentGroupMemberWithGroupAndRepo = AssignmentGroupMember & {
  assignment_groups: (AssignmentGroup & { repositories: Repo[] }) | null;
};

export default async function StudentPage({ params }: { params: Promise<{ course_id: string }> }) {
  const { course_id } = await params;

  const client = await createClient();
  const user = (await client.auth.getUser()).data.user;
  const { data: course } = await client.from("classes").select("time_zone").eq("id", Number(course_id)).single();

  const { data: private_profile_id } = await client
    .from("user_roles")
    .select("private_profile_id")
    .eq("user_id", user!.id)
    .eq("class_id", Number(course_id))
    .single();

  let groups: { data: AssignmentGroupMemberWithGroupAndRepo[] | null; error: PostgrestError | null } = {
    data: [],
    error: null
  };

  if (private_profile_id?.private_profile_id) {
    groups = await client
      .from("assignment_groups_members")
      .select("*, assignment_groups(*, repositories(*))")
      .eq("assignment_groups.class_id", Number(course_id))
      .eq("profile_id", private_profile_id.private_profile_id);
  }

  //TODO need to get the group assignments, too!
  let assignments = await client
    .from("assignments")
    .select("*, submissions(*, grader_results(*)), repositories(*, user_roles(user_id))")
    .eq("class_id", Number(course_id))
    .eq("repositories.user_roles.user_id", user!.id)
    .order("due_date", { ascending: false });

  //list identities
  const identities = await client.auth.getUserIdentities();
  const githubIdentity = identities.data?.identities.find((identity) => identity.provider === "github");

  let actions = <></>;
  if (!githubIdentity) {
    actions = <LinkAccount />;
  } else {
    const assignmentsWithoutRepos = assignments.data?.filter((assignment) => {
      if (!assignment.template_repo || !assignment.template_repo.includes("/")) {
        return false;
      }
      const hasIndividualRepo = assignment.repositories.length > 0;
      const assignmentGroup = groups?.data?.find((group) => group.assignment_id === assignment.id);
      const hasGroupRepo = assignmentGroup?.assignment_groups?.repositories.length || 0 > 0;
      if (assignmentGroup) {
        return !hasGroupRepo;
      }
      //Don't try to create a repo for a group assignment if we don't have a group
      if (assignment.group_config === "groups") {
        return false;
      }
      return !hasIndividualRepo;
    });
    if (assignmentsWithoutRepos?.length) {
      console.log(`Creating repos for ${assignmentsWithoutRepos.map((a) => a.title).join(", ")}`);
      await autograderCreateReposForStudent(client);
      assignments = await client
        .from("assignments")
        .select("*, submissions(*, grader_results(*)), repositories(*, user_roles(user_id))")
        .eq("class_id", Number(course_id))
        .eq("repositories.user_roles.user_id", user!.id)
        .order("due_date", { ascending: false });
      // Refetch groups only if profile_id is available
      if (private_profile_id?.private_profile_id) {
        groups = await client
          .from("assignment_groups_members")
          .select("*, assignment_groups(*, repositories(*))")
          .eq("assignment_groups.class_id", Number(course_id))
          .eq("profile_id", private_profile_id.private_profile_id);
      }
      actions = (
        <>
          <Alert status="info">
            GitHub repos created for you. You have been *invited* to join them. You will need to accept the invitation
            within the next 7 days. You will find the invitation in your email (whichever you use for GitHub), and also
            in your <Link href="https://github.com/notifications">GitHub notifications</Link>.
          </Alert>
        </>
      );
    }
  }
  const getLatestSubmission = (assignment: AssignmentWithRepositoryAndSubmissionsAndGraderResults) => {
    return assignment.submissions.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )[0];
  };
  return (
    <Container>
      {actions}
      <Heading size="lg" mb={4}>
        Assignments
      </Heading>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>
              Due Date
              <br />
              <Text fontSize="sm" color="fg.muted">
                ({course?.time_zone})
              </Text>
            </Table.ColumnHeader>
            <Table.ColumnHeader>Name</Table.ColumnHeader>
            <Table.ColumnHeader>Latest Submission</Table.ColumnHeader>
            <Table.ColumnHeader display={{ base: "none", sm: "table-cell" }}>GitHub Repository</Table.ColumnHeader>
            <Table.ColumnHeader display={{ base: "none", sm: "table-cell" }}>Group</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {assignments.data?.map((assignment) => {
            const mostRecentSubmission = getLatestSubmission(assignment);
            let repo = "-";
            if (assignment.repositories.length) {
              repo = assignment.repositories[0].repository;
            }
            const group = groups?.data?.find((group) => group.assignment_id === assignment.id);
            if (group && group.assignment_groups) {
              if (group.assignment_groups.repositories.length) {
                repo = group.assignment_groups.repositories[0].repository;
              } else {
                repo = "-";
              }
            }
            return (
              <Table.Row key={assignment.id}>
                <Table.Cell>
                  <Link prefetch={true} href={`/course/${course_id}/assignments/${assignment.id}`}>
                    <AssignmentDueDate assignment={assignment} />
                  </Link>
                </Table.Cell>
                <Table.Cell>
                  <Link prefetch={true} href={`/course/${course_id}/assignments/${assignment.id}`}>
                    {assignment.title}
                  </Link>
                </Table.Cell>
                <Table.Cell>
                  {mostRecentSubmission ? (
                    <Link
                      prefetch={true}
                      href={`/course/${course_id}/assignments/${assignment.id}/submissions/${mostRecentSubmission?.id}`}
                    >
                      #{mostRecentSubmission.ordinal} ({mostRecentSubmission.grader_results?.score || 0}/
                      {mostRecentSubmission.grader_results?.max_score || 0})
                    </Link>
                  ) : (
                    "-"
                  )}
                </Table.Cell>
                <Table.Cell display={{ base: "none", sm: "table-cell" }}>
                  <Link target="_blank" href={`https://github.com/${repo}`}>
                    {repo}
                  </Link>{" "}
                </Table.Cell>
                <Table.Cell display={{ base: "none", sm: "table-cell" }}>
                  {assignment.group_config === "individual"
                    ? "Individual"
                    : group?.assignment_groups?.name || "No Group"}
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
    </Container>
  );
}
