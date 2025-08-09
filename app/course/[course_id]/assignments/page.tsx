"use client";
import LinkAccount from "@/components/github/link-account";
import ResendOrgInvitation from "@/components/github/resend-org-invitation";
import { SelfReviewDueDate } from "@/components/ui/assignment-due-date";
import Link from "@/components/ui/link";
import useAuthState from "@/hooks/useAuthState";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useIdentity } from "@/hooks/useIdentities";
import { AssignmentGroup, AssignmentGroupMember, Repo } from "@/utils/supabase/DatabaseTypes";
import type { Assignment } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Container, EmptyState, Heading, Icon, Skeleton, Table, Text } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { useList } from "@refinedev/core";
import { UserIdentity } from "@supabase/supabase-js";
import { addHours, differenceInHours } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { FaCheckCircle } from "react-icons/fa";

// Define the type for the groups query result
type AssignmentGroupMemberWithGroupAndRepo = AssignmentGroupMember & {
  assignment_groups: (AssignmentGroup & { repositories: Repo[] }) | null;
};

type AssignmentUnit = {
  key: string;
  name: string;
  type: "assignment" | "self review";
  due_date: TZDate | undefined;
  due_date_component: JSX.Element;
  due_date_link?: string;
  repo: string;
  name_link: string;
  submission_text: string;
  submission_link?: string;
  group: string;
};

export type AssignmentsForStudentDashboard = Omit<
  Database["public"]["Views"]["assignments_for_student_dashboard"]["Row"],
  "id"
> & {
  id: number;
};

export default function StudentPage() {
  const { identities } = useIdentity();
  const { course_id } = useParams();
  const { user } = useAuthState();
  const { role } = useClassProfiles();
  const { data: courseData } = useList<{ time_zone: string }>({
    resource: "classes",
    meta: {
      select: "time_zone",
      limit: 1
    },
    filters: [{ field: "id", operator: "eq", value: Number(course_id) }],
    queryOptions: {
      enabled: !!course_id
    }
  });
  const course = courseData && courseData.data.length > 0 ? courseData.data[0] : null;

  const private_profile_id = role.private_profile_id;
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
  const groups: AssignmentGroupMemberWithGroupAndRepo[] | null = groupsData?.data ?? null;

  const { data: assignmentsData, isLoading } = useList<AssignmentsForStudentDashboard>({
    resource: "assignments_for_student_dashboard",
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "student_user_id", operator: "eq", value: user?.id },
      { field: "student_profile_id", operator: "eq", value: private_profile_id }
    ],
    pagination: {
      pageSize: 1000
    },
    queryOptions: {
      enabled: !!user && !!private_profile_id
    },
    sorters: [{ field: "due_date", order: "desc" }]
  });

  const assignments = assignmentsData?.data ?? null;

  const githubIdentity: UserIdentity | null = identities?.find((identity) => identity.provider === "github") ?? null;

  const actions = !githubIdentity ? <LinkAccount /> : <></>;

  const allAssignedWork = useMemo(() => {
    const result: AssignmentUnit[] = [];
    assignments?.forEach(async (assignment) => {
      const group = groups?.find((group) => group.assignment_id === assignment.id);
      let repo = assignment.repository || "-";
      if (group && group.assignment_groups) {
        if (group.assignment_groups.repositories.length) {
          repo = group.assignment_groups.repositories[0].repository;
        } else {
          repo = "-";
        }
      }

      // The view already provides the effective due date with all calculations
      const modifiedDueDate = assignment.due_date
        ? new TZDate(assignment.due_date, course?.time_zone ?? "America/New_York")
        : undefined;
      result.push({
        key: assignment.id.toString(),
        name: assignment.title!,
        type: "assignment",
        due_date: modifiedDueDate,
        due_date_component: (
          <>
            {modifiedDueDate &&
              formatInTimeZone(modifiedDueDate, course?.time_zone || "America/New_York", "MMM d h:mm aaa")}
          </>
        ),
        due_date_link: `/course/${course_id}/assignments/${assignment.id}`,
        repo: repo,
        name_link: `/course/${course_id}/assignments/${assignment.id}`,
        submission_text: !assignment.submission_id
          ? "Have not submitted yet"
          : `#${assignment.submission_ordinal} (${assignment.grader_result_score || 0}/${assignment.grader_result_max_score || 0})`,
                submission_link: assignment.submission_id
            ? `/course/${course_id}/assignments/${assignment.id}/submissions/${assignment.submission_id}`
            : undefined,
        group: assignment.group_config === "individual" ? "Individual" : group?.assignment_groups?.name || "No Group"
      });

      if (assignment.self_review_setting_id && assignment.review_assignment_id) {
        const evalDueDate = assignment.due_date
          ? addHours(new Date(assignment.due_date), assignment.self_review_deadline_offset ?? 0)
          : undefined;
        result.push({
          key: assignment.id.toString() + "selfReview",
          name: "Self Review for " + assignment.title,
          type: "self review",
          due_date: evalDueDate ? new TZDate(evalDueDate) : undefined,
          due_date_component: (
            <SelfReviewDueDate
              assignment={assignment as unknown as Assignment}
              offsetHours={assignment.self_review_deadline_offset ?? 0}
            />
          ),
          repo: repo,
          name_link: `/course/${course_id}/assignments/${assignment.id}/submissions/${assignment.review_submission_id}/files?review_assignment_id=${assignment.review_assignment_id}`,
          submission_text: assignment.submission_review_completed_at ? "Submitted" : "Not Submitted",
          group: assignment.group_config === "individual" ? "Individual" : group?.assignment_groups?.name || "No Group"
        });
      }
    });
    // Sort by effective due date (includes lab-based scheduling and extensions)
    return result.sort((a, b) => {
      const dateA = a.due_date ? new TZDate(a.due_date) : new TZDate(new Date());
      const dateB = b.due_date ? new TZDate(b.due_date) : new TZDate(new Date());
      return dateB.getTime() - dateA.getTime();
    });
  }, [assignments, groups, course, course_id]);

  const workInFuture = useMemo(() => {
    const curTimeInCourseTimezone = new TZDate(new Date(), course?.time_zone ?? "America/New_York");
    return allAssignedWork.filter((work) => {
      return work.due_date && work.due_date > curTimeInCourseTimezone;
    });
  }, [allAssignedWork, course?.time_zone]);
  workInFuture.sort((a, b) => {
    return (a.due_date?.getTime() ?? 0) - (b.due_date?.getTime() ?? 0);
  });
  const workInPast = useMemo(() => {
    const curTimeInCourseTimezone = new TZDate(new Date(), course?.time_zone ?? "America/New_York");
    return allAssignedWork.filter((work) => {
      return work.due_date && work.due_date < curTimeInCourseTimezone;
    });
  }, [allAssignedWork, course?.time_zone]);
  workInPast.sort((a, b) => {
    return (b.due_date?.getTime() ?? 0) - (a.due_date?.getTime() ?? 0);
  });
  return (
    <Container>
      {actions}
      <ResendOrgInvitation />
      <Heading size="lg" mb={4}>
        Upcoming Assignments
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
          {workInFuture.length === 0 && !isLoading && (
            <Table.Row>
              <Table.Cell colSpan={5}>
                <EmptyState.Root size="md">
                  <EmptyState.Content>
                    <EmptyState.Indicator>
                      <Icon as={FaCheckCircle} />
                    </EmptyState.Indicator>
                    <EmptyState.Title>No upcoming deadlines available</EmptyState.Title>
                    <EmptyState.Description>
                      Your instructor may not have released any upcoming assignments yet.
                    </EmptyState.Description>
                  </EmptyState.Content>
                </EmptyState.Root>
              </Table.Cell>
            </Table.Row>
          )}
          {isLoading && (
            <Table.Row>
              <Table.Cell colSpan={5}>
                <Skeleton height="20px" />
                <Skeleton height="20px" />
              </Table.Cell>
            </Table.Row>
          )}
          {workInFuture.map((work) => {
            const isCloseDeadline = work.due_date && differenceInHours(work.due_date, new Date()) < 24;
            return (
              <Table.Row
                key={work.key}
                border={isCloseDeadline ? "2px solid" : "none"}
                borderColor={isCloseDeadline ? "border.info" : undefined}
                bg={isCloseDeadline ? "bg.info" : undefined}
              >
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
                  </Link>
                </Table.Cell>
                <Table.Cell display={{ base: "none", sm: "table-cell" }}>{work.group}</Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
      <Heading size="lg" mb={4}>
        Past Assignments
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
          {workInPast.length === 0 && !isLoading && (
            <Table.Row>
              <Table.Cell colSpan={5}>
                <EmptyState.Root size="md">
                  <EmptyState.Content>
                    <EmptyState.Indicator>
                      <Icon as={FaCheckCircle} />
                    </EmptyState.Indicator>
                    <EmptyState.Title>No due dates have passed</EmptyState.Title>
                  </EmptyState.Content>
                </EmptyState.Root>
              </Table.Cell>
            </Table.Row>
          )}
          {isLoading && (
            <Table.Row>
              <Table.Cell colSpan={5}>
                <Skeleton height="20px" />
                <Skeleton height="20px" />
              </Table.Cell>
            </Table.Row>
          )}
          {workInPast.map((work) => {
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
                  </Link>
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
