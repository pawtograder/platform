import LinkAccount from "@/components/github/link-account";
import { Alert } from "@/components/ui/alert";
import { AssignmentDueDate, SelfReviewDueDate } from "@/components/ui/assignment-due-date";
import Link from "@/components/ui/link";
import { autograderCreateReposForStudent } from "@/lib/edgeFunctions";
import { dueDateAdvice } from "@/lib/utils";
import {
  AssignmentGroup,
  AssignmentGroupMember,
  AssignmentWithRepositoryAndSubmissionsAndGraderResults,
  Repo
} from "@/utils/supabase/DatabaseTypes";
import { createClient } from "@/utils/supabase/server";
import { Card, Container, Flex, Heading, Table, Text } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { PostgrestError } from "@supabase/supabase-js";
import { addHours, addMinutes, differenceInHours } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";

// Define the type for the groups query result
type AssignmentGroupMemberWithGroupAndRepo = AssignmentGroupMember & {
  assignment_groups: (AssignmentGroup & { repositories: Repo[] }) | null;
};

type AssignmentUnit = {
  key: string;
  name: string;
  type: "assignment" | "self review";
  due_date: TZDate;
  due_date_component: JSX.Element;
  due_date_link?: string;
  repo: string;
  name_link: string;
  submission_text: string;
  submission_link?: string;
  group: string;
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
    .select(
      `
            *, 
            submissions(*, grader_results(*)), 
            repositories(*, user_roles(user_id)), 
            assignment_self_review_settings!assignments_self_review_setting_fkey(*), 
            review_assignments(*, submission_reviews(completed_at)),
            assignment_due_date_exceptions!assignment_late_exception_assignment_id_fkey(*)
  `
    )
    .eq("class_id", Number(course_id))
    .eq("repositories.user_roles.user_id", user!.id)
    .eq("review_assignments.assignee_profile_id", private_profile_id?.private_profile_id ?? "")
    .eq("assignment_due_date_exceptions.student_id", private_profile_id?.private_profile_id ?? "")
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
        .select(
          `
            *, 
            submissions(*, grader_results(*)), 
            repositories(*, user_roles(user_id)), 
            assignment_self_review_settings!assignments_self_review_setting_fkey(*), 
            review_assignments(*, submission_reviews(completed_at)),
            assignment_due_date_exceptions!assignment_late_exception_assignment_id_fkey(*)
  `
        )
        .eq("class_id", Number(course_id))
        .eq("repositories.user_roles.user_id", user!.id)
        .eq("review_assignments.assignee_profile_id", private_profile_id?.private_profile_id ?? "")
        .eq("assignment_due_date_exceptions.student_id", private_profile_id?.private_profile_id ?? "")
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

  const allAssignedWork = () => {
    const result: AssignmentUnit[] = [];
    assignments?.data?.forEach(async (assignment) => {
      const mostRecentSubmission = getLatestSubmission(assignment);
      const group = groups?.data?.find((group) => group.assignment_id === assignment.id);
      let repo = "-";
      if (assignment.repositories.length) {
        repo = assignment.repositories[0].repository;
      }
      if (group && group.assignment_groups) {
        if (group.assignment_groups.repositories.length) {
          repo = group.assignment_groups.repositories[0].repository;
        } else {
          repo = "-";
        }
      }
      const hoursExtended = assignment.assignment_due_date_exceptions.reduce((acc, curr) => acc + curr.hours, 0);
      const minutesExtended = assignment.assignment_due_date_exceptions.reduce((acc, curr) => acc + curr.minutes, 0);
      const originalDueDate = new TZDate(assignment.due_date);
      const modifiedDueDate = new TZDate(
        addMinutes(addHours(originalDueDate, hoursExtended), minutesExtended),
        course?.time_zone ?? "America/New_York"
      );
      result.push({
        key: assignment.id.toString(),
        name: assignment.title,
        type: "assignment",
        due_date: new TZDate(modifiedDueDate),
        due_date_component: <AssignmentDueDate assignment={assignment} />,
        due_date_link: `/course/${course_id}/assignments/${assignment.id}`,
        repo: repo,
        name_link: `/course/${course_id}/assignments/${assignment.id}`,
        submission_text: !mostRecentSubmission
          ? "Have not submitted yet"
          : `#${mostRecentSubmission.ordinal} (${mostRecentSubmission.grader_results?.score || 0}/${mostRecentSubmission.grader_results?.max_score || 0})`,
        submission_link: mostRecentSubmission
          ? `/course/${course_id}/assignments/${assignment.id}/submissions/${mostRecentSubmission?.id}`
          : undefined,
        group: assignment.group_config === "individual" ? "Individual" : group?.assignment_groups?.name || "No Group"
      });

      if (assignment.assignment_self_review_settings.enabled && assignment.review_assignments.length > 0) {
        const evalDueDate = addHours(modifiedDueDate, assignment.assignment_self_review_settings.deadline_offset ?? 0);
        result.push({
          key: assignment.id.toString() + "selfReview",
          name: "Self Review for " + assignment.title,
          type: "self review",
          due_date: new TZDate(evalDueDate),
          due_date_component: <SelfReviewDueDate assignment={assignment} />,
          repo: repo,
          name_link: `/course/${course_id}/assignments/${assignment.id}/submissions/${assignment.review_assignments[0].submission_id}/files?review_assignment_id=${assignment.review_assignments[0].id}`,
          submission_text: assignment.review_assignments[0].submission_reviews.completed_at
            ? "Submitted"
            : "Not Submitted",
          group: assignment.group_config === "individual" ? "Individual" : group?.assignment_groups?.name || "No Group"
        });
      }
    });
    return result.sort((a, b) => {
      const dateA = new TZDate(a.due_date);
      const dateB = new TZDate(b.due_date);
      return dateB.getTime() - dateA.getTime();
    });
  };

  return (
    <Container>
      {actions}
      <Flex mb="4" gap="4" flexDir={"column"}>
        <Heading size="lg">Upcoming Deadlines</Heading>
        <Flex>
          {allAssignedWork()
            .filter((work) => {
              return work.due_date > new TZDate(new Date(), course?.time_zone ?? "America/New_York");
            })
            .map((work) => {
              return (
                <Card.Root width={"sm"} key={work.key}>
                  <Card.Header>
                    <Heading size="md">
                      <Link prefetch={true} href={work.name_link}>
                        {work.name}
                      </Link>
                    </Heading>
                  </Card.Header>
                  <Card.Body fontSize="sm">
                    <Text>
                      <strong>Type:</strong> {work.type}
                    </Text>
                    <Text>
                      <strong>Due:</strong>{" "}
                      {formatInTimeZone(work.due_date, course?.time_zone || "America/New_York", "MMM d h:mm aaa")}{" "}
                      {differenceInHours(
                        new TZDate(work.due_date),
                        TZDate.tz(course?.time_zone || "America/New_York")
                      ) <= 48
                        ? dueDateAdvice(work.due_date.toString(), course?.time_zone ?? undefined)
                        : ""}
                    </Text>
                    <Text>
                      <strong>Status:</strong> {work.type == "assignment" ? "using submission " : ""}
                      {work.submission_text}
                    </Text>
                  </Card.Body>
                </Card.Root>
              );
            })}
        </Flex>
      </Flex>
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
          {allAssignedWork().map((work) => {
            return (
              <Table.Row key={work.key}>
                <Table.Cell>
                  <Link prefetch={true} href={work.due_date_link ?? ""}>
                    {work.due_date_component}
                  </Link>
                </Table.Cell>
                <Table.Cell>
                  <Link prefetch={true} href={work.name_link}>
                    {work.name}
                  </Link>
                </Table.Cell>
                <Table.Cell>
                  {work.submission_link ? (
                    <Link prefetch={true} href={work.submission_link}>
                      {work.submission_text}
                    </Link>
                  ) : (
                    <Text>{work.submission_text}</Text>
                  )}
                </Table.Cell>
                <Table.Cell display={{ base: "none", sm: "table-cell" }}>
                  <Link target="_blank" href={`https://github.com/${work.repo}`}>
                    {work.repo}
                  </Link>{" "}
                </Table.Cell>
                <Table.Cell display={{ base: "none", sm: "table-cell" }}>{work.group}</Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
    </Container>
  );
}
