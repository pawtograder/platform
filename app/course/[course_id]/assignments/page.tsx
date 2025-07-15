"use client";
import LinkAccount from "@/components/github/link-account";
import { Alert } from "@/components/ui/alert";
import { AssignmentDueDate, SelfReviewDueDate } from "@/components/ui/assignment-due-date";
import Link from "@/components/ui/link";
import useAuthState from "@/hooks/useAuthState";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useCourseController } from "@/hooks/useCourseController";
import { useIdentity } from "@/hooks/useIdentities";
import { autograderCreateReposForStudent } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import {
  Assignment,
  AssignmentDueDateException,
  AssignmentGroup,
  AssignmentGroupMember,
  Repo,
  Repository,
  ReviewAssignments,
  SelfReviewSettings,
  SubmissionReview,
  SubmissionWithGraderResults
} from "@/utils/supabase/DatabaseTypes";
import { Container, EmptyState, Heading, Icon, Spinner, Table, Text } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { useInvalidate, useList } from "@refinedev/core";
import { UserIdentity } from "@supabase/supabase-js";
import { addHours, addMinutes, differenceInHours } from "date-fns";
import { useParams } from "next/navigation";
import { UUID } from "node:crypto";
import { useEffect, useMemo, useState } from "react";
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

type ReviewAssignmentsWithSubmissions = ReviewAssignments & {
  submission_reviews: SubmissionReview[] & {
    completed_at: Date;
  };
};

type ReposWithUserIds = Repository & {
  user_roles: UUID;
};

type AssignmentWithALot = Assignment & {
  submissions: SubmissionWithGraderResults[];
  repositories: ReposWithUserIds[];
  assignment_self_review_settings: SelfReviewSettings;
  review_assignments: ReviewAssignmentsWithSubmissions[];
  assignment_due_date_exceptions: AssignmentDueDateException[];
};

export default function StudentPage() {
  const { identities } = useIdentity();
  const { course_id } = useParams();
  const { user } = useAuthState();
  const courseController = useCourseController();
  const { role } = useClassProfiles();
  const supabase = createClient();
  const { data: courseData } = useList({
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
  const lab_section_id = role.lab_section_id;
  const invalidate = useInvalidate();
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

  const { data: assignmentsData } = useList<AssignmentWithALot>({
    resource: "assignments",
    meta: {
      select: `
            *, 
            submissions(*, grader_results(*)), 
            repositories(*, user_roles(user_id)), 
            assignment_self_review_settings!assignments_self_review_setting_fkey(*), 
            review_assignments(*, submission_reviews(completed_at)),
            assignment_due_date_exceptions!assignment_late_exception_assignment_id_fkey(*)
  `
    },
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "repositories.user_roles.user_id", operator: "eq", value: user?.id },
      { field: "review_assignments.assignee_profile_id", operator: "eq", value: private_profile_id },
      { field: "assignment_due_date_exceptions.student_id", operator: "eq", value: private_profile_id }
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
  const [labSectionsLoaded, setLabSectionsLoaded] = useState(false);
  useEffect(() => {
    const { data, unsubscribe } = courseController.listLabSectionMeetings((data) => {
      setLabSectionsLoaded(data.length > 0);
    });
    setLabSectionsLoaded(data.length > 0);
    return () => unsubscribe();
  }, [courseController]);

  const assignmentsWithoutRepos = useMemo(() => githubIdentity
    ? assignments?.filter((assignment) => {
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
    })
    : null, [assignments, groups, githubIdentity]);

  const hasLabSectionAssignments = useMemo(() => {
    return assignments?.some((assignment) => {
      return assignment.minutes_due_after_lab !== null;
    });
  }, [assignments]);
  const actions = !githubIdentity ? (
    <LinkAccount />
  ) : assignmentsWithoutRepos?.length ? (
    <>
      <Alert status="info">
        GitHub repos created for you. You have been *invited* to join them. You will need to accept the invitation
        within the next 7 days. You will find the invitation in your email (whichever you use for GitHub), and also in
        your <Link href="https://github.com/notifications">GitHub notifications</Link>.
      </Alert>
    </>
  ) : (
    <></>
  );
  const [loading, setLoading] = useState(true);
  const hasGitHubIdentity = githubIdentity?.user_id !== undefined;
  useEffect(() => {
    const createRepos = async () => {
      try {
        setLoading(true);
        await autograderCreateReposForStudent(supabase);
        await invalidate({ resource: "repositories", invalidates: ["all"] });
      } finally {
        setLoading(false);
      }
    };
    if (hasGitHubIdentity && supabase) {
      createRepos();
    }
  }, [hasGitHubIdentity, supabase, invalidate]);

  const allAssignedWork = useMemo(() => {
    const getLatestSubmission = (assignment: AssignmentWithALot) => {
      return assignment.submissions.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )[0];
    };

    const result: AssignmentUnit[] = [];
    assignments?.forEach(async (assignment) => {
      const mostRecentSubmission = getLatestSubmission(assignment);
      const group = groups?.find((group) => group.assignment_id === assignment.id);
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

      // Calculate the effective due date for this student
      // This ensures sorting/filtering uses the actual due date the student sees,
      // which includes both lab-based scheduling and manual due date extensions
      let effectiveDueDate: Date | undefined;
      if (private_profile_id && courseController.isLoaded && (labSectionsLoaded || !hasLabSectionAssignments)) {
        // Use the CourseController's lab-aware calculation
        const labAwareDueDate = courseController.calculateEffectiveDueDate(assignment, { studentPrivateProfileId: private_profile_id, labSectionId: lab_section_id ?? undefined });

        // Apply due date extensions on top of the lab-aware due date
        const hoursExtended = assignment.assignment_due_date_exceptions.reduce((acc, curr) => acc + curr.hours, 0);
        const minutesExtended = assignment.assignment_due_date_exceptions.reduce((acc, curr) => acc + curr.minutes, 0);
        effectiveDueDate = addMinutes(addHours(labAwareDueDate, hoursExtended), minutesExtended);
      } else {
        effectiveDueDate = undefined;
      }

      const modifiedDueDate = effectiveDueDate ? new TZDate(effectiveDueDate, course?.time_zone ?? "America/New_York") : undefined;
      result.push({
        key: assignment.id.toString(),
        name: assignment.title,
        type: "assignment",
        due_date: modifiedDueDate,
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
        const evalDueDate = effectiveDueDate ? addHours(effectiveDueDate, assignment.assignment_self_review_settings.deadline_offset ?? 0) : undefined;
        result.push({
          key: assignment.id.toString() + "selfReview",
          name: "Self Review for " + assignment.title,
          type: "self review",
          due_date: evalDueDate ? new TZDate(evalDueDate) : undefined,
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
    // Sort by effective due date (includes lab-based scheduling and extensions)
    return result.sort((a, b) => {
      const dateA = a.due_date ? new TZDate(a.due_date) : new TZDate(new Date());
      const dateB = b.due_date ? new TZDate(b.due_date) : new TZDate(new Date());
      return dateB.getTime() - dateA.getTime();
    });
  }, [assignments, groups, courseController, private_profile_id, lab_section_id, course, course_id, labSectionsLoaded]);

  const workInFuture = useMemo(() => {
    const curTimeInCourseTimezone = new TZDate(new Date(), course?.time_zone ?? "America/New_York");
    return allAssignedWork.filter((work) => {
      return work.due_date && work.due_date > curTimeInCourseTimezone;
    });
  }, [allAssignedWork]);
  workInFuture.sort((a, b) => {
    return (a.due_date?.getTime() ?? 0) - (b.due_date?.getTime() ?? 0);
  });
  const workInPast = useMemo(() => {
    const curTimeInCourseTimezone = new TZDate(new Date(), course?.time_zone ?? "America/New_York");
    return allAssignedWork.filter((work) => {
      return work.due_date && work.due_date < curTimeInCourseTimezone;
    });
  }, [allAssignedWork]);
  workInPast.sort((a, b) => {
    return (b.due_date?.getTime() ?? 0) - (a.due_date?.getTime() ?? 0);
  });
  return (
    <Container>
      {actions}
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
          {(labSectionsLoaded && workInFuture.length === 0) && <Table.Row><Table.Cell colSpan={5}><EmptyState.Root size="md"><EmptyState.Content><EmptyState.Indicator><Icon as={FaCheckCircle} /></EmptyState.Indicator><EmptyState.Title>No upcoming deadlines available</EmptyState.Title><EmptyState.Description>Your instructor may not have released any upcoming assignments yet.</EmptyState.Description></EmptyState.Content></EmptyState.Root></Table.Cell></Table.Row>}
          {(!labSectionsLoaded && hasLabSectionAssignments) && <Table.Row><Table.Cell colSpan={5}><Spinner /></Table.Cell></Table.Row>}
          {workInFuture.map((work) => {
            const isCloseDeadline = work.due_date && differenceInHours(work.due_date, new Date()) < 24;
            return (
              <Table.Row key={work.key} border={isCloseDeadline ? "2px solid" : "none"} borderColor={isCloseDeadline ? "border.info" : undefined}
                bg={isCloseDeadline ? "bg.info" : undefined}>
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
                  {loading && !work.repo ? (
                    <Spinner />
                  ) : (
                    <Link target="_blank" href={`https://github.com/${work.repo}`}>
                      {work.repo}
                    </Link>
                  )}
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
          {workInPast.length === 0 && <Table.Row><Table.Cell colSpan={5}><EmptyState.Root size="md"><EmptyState.Content><EmptyState.Indicator><Icon as={FaCheckCircle} /></EmptyState.Indicator><EmptyState.Title>No due dates have passed</EmptyState.Title></EmptyState.Content></EmptyState.Root></Table.Cell></Table.Row>}
          {workInPast.map((work) => {
            return (
              <Table.Row key={work.key}>
                <Table.Cell>
                  <Link prefetch={true} href={work.name_link ?? ""}>
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
                  {loading && !work.repo ? (
                    <Spinner />
                  ) : (
                    <Link target="_blank" href={`https://github.com/${work.repo}`}>
                      {work.repo}
                    </Link>
                  )}
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
