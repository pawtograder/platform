"use client";
import LinkAccount from "@/components/github/link-account";
import { Alert } from "@/components/ui/alert";
import { AssignmentDueDate } from "@/components/ui/assignment-due-date";
import Link from "@/components/ui/link";
import useAuthState from "@/hooks/useAuthState";
import { autograderCreateReposForStudent } from "@/lib/edgeFunctions";
import {
  AssignmentGroup,
  AssignmentGroupMember,
  AssignmentWithRepositoryAndSubmissionsAndGraderResults,
  Repo
} from "@/utils/supabase/DatabaseTypes";
import { Container, Heading, Spinner, Table, Text } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { useParams } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { useEffect, useState } from "react";
import { useIdentity } from "@/hooks/useIdentities";

// Define the type for the groups query result
type AssignmentGroupMemberWithGroupAndRepo = AssignmentGroupMember & {
  assignment_groups: (AssignmentGroup & { repositories: Repo[] }) | null;
};

export default function StudentPage() {
  const { identities } = useIdentity();
  const { course_id } = useParams();
  const { user } = useAuthState();
  const supabase = createClient();
  const { data: courseData } = useList({
    resource: "classes",
    meta: {
      select: "time_zone",
      limit: 1
    },
    filters: [{ field: "id", operator: "eq", value: course_id }],
    queryOptions: {
      enabled: !!course_id
    }
  });

  const course = courseData && courseData.data.length > 0 ? courseData.data[0] : null;

  const { data: private_profile_id_data } = useList({
    resource: "user_roles",
    meta: {
      select: "private_profile_id",
      limit: 1
    },
    filters: [
      { field: "user_id", operator: "eq", value: user!.id },
      { field: "class_id", operator: "eq", value: course_id }
    ],
    queryOptions: {
      enabled: !!course_id
    }
  });

  const private_profile_id =
    private_profile_id_data && private_profile_id_data.data.length > 0
      ? private_profile_id_data.data[0].private_profile_id
      : null;
  const { data: groupsData } = useList<AssignmentGroupMemberWithGroupAndRepo>({
    resource: "assignment_groups_members",
    meta: {
      select: "*, assignment_groups(*, repositories(*))"
    },
    filters: [
      { field: "assignment_groups.class_id", operator: "eq", value: Number(course_id) },
      { field: "profile_id", operator: "eq", value: private_profile_id }
    ],
    queryOptions: {
      enabled: !!private_profile_id
    }
  });
  const groups = groupsData?.data ?? null;
  const { data: assignmentsData } = useList<AssignmentWithRepositoryAndSubmissionsAndGraderResults>({
    resource: "assignments",
    meta: {
      select: "*, submissions(*, grader_results(*)), repositories(*, user_roles(user_id))"
    },
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "repositories.user_roles.user_id", operator: "eq", value: user?.id }
    ],
    queryOptions: {
      enabled: !!user
    },
    sorters: [{ field: "due_date", order: "desc" }]
  });
  const assignments = assignmentsData?.data ?? null;

  //list identities
  const githubIdentity = identities?.find((identity) => identity.provider === "github");

  const assignmentsWithoutRepos = assignments?.filter((assignment) => {
    if (!assignment.template_repo || !assignment.template_repo.includes("/")) {
      return false;
    }
    const hasIndividualRepo = assignment.repositories.length > 0;
    const assignmentGroup = groups?.find((group) => group.assignment_id === assignment.id);
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

  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const createRepos = async () => {
      try {
        setLoading(true);
        if (githubIdentity) {
          await autograderCreateReposForStudent(supabase);
        }
      } finally {
        setLoading(false);
      }
    };
    createRepos();
  }, []);

  const actions = githubIdentity ? (
    <></>
  ) : assignmentsWithoutRepos?.length ? (
    <LinkAccount />
  ) : (
    <>
      <Alert status="info">
        GitHub repos created for you. You have been *invited* to join them. You will need to accept the invitation
        within the next 7 days. You will find the invitation in your email (whichever you use for GitHub), and also in
        your <Link href="https://github.com/notifications">GitHub notifications</Link>.
      </Alert>
    </>
  );
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
            <Table.ColumnHeader>GitHub Repository</Table.ColumnHeader>
            <Table.ColumnHeader>Group</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {assignments?.map((assignment) => {
            const mostRecentSubmission = getLatestSubmission(assignment);
            let repo = "-";
            if (assignment.repositories.length) {
              repo = assignment.repositories[0].repository;
            }
            const group = groups?.find((group) => group.assignment_id === assignment.id);
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
                <Table.Cell>
                  {loading ? (
                    <Spinner />
                  ) : (
                    <Link target="_blank" href={`https://github.com/${repo}`}>
                      {repo}
                    </Link>
                  )}
                </Table.Cell>
                <Table.Cell>
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
