"use client";
import LinkAccount from "@/components/github/link-account";
import ResendOrgInvitation from "@/components/github/resend-org-invitation";
import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { SelfReviewDueDate } from "@/components/ui/assignment-due-date";
import { DueDateDisplay } from "@/components/ui/due-date-display";
import Link from "@/components/ui/link";
import { PageContainer } from "@/components/ui/page-container";
import { ResponsiveTable } from "@/components/ui/responsive-table";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useAssignments } from "@/hooks/useCourseController";
import { useSuggestedDueDateEmphasisEnabled } from "@/hooks/useCourseFeatures";
import { useIdentity } from "@/hooks/useIdentities";
import { createClient } from "@/utils/supabase/client";
import { AssignmentGroup, AssignmentGroupMember, Repo } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { InputGroup } from "@/components/ui/input-group";
import { Box, EmptyState, Heading, Icon, Input, Skeleton, Stack, Table, Text } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import { BsSearch } from "react-icons/bs";
import { TZDate } from "@date-fns/tz";
import { useList } from "@refinedev/core";
import { UserIdentity } from "@supabase/supabase-js";
import { addHours, differenceInHours } from "date-fns";
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
  /** The date the row displays as "Due" — the suggested date in emphasized courses. Drives ordering and the 24-hour highlight. */
  primary_date: TZDate | undefined;
  due_date_component: JSX.Element;
  repo: string;
  is_repo_ready: boolean;
  name_link: string;
  submission_text: string;
  submission_link?: string;
  group: string;
};

export type AssignmentsForStudentDashboard =
  Database["public"]["Functions"]["get_assignments_for_student_dashboard"]["Returns"][number];

function formatLatestSubmissionLabel(assignment: AssignmentsForStudentDashboard): string {
  if (!assignment.submission_id) {
    return "Have not submitted yet";
  }
  const ordinal = assignment.submission_ordinal ?? 0;
  const gradingComplete =
    assignment.grading_submission_review_completed_at != null &&
    assignment.grading_total_score != null &&
    assignment.total_points != null;
  if (gradingComplete) {
    return `#${ordinal} (${assignment.grading_total_score}/${assignment.total_points})`;
  }
  const agScore = assignment.grader_result_score ?? 0;
  const agMax = assignment.grader_result_max_score ?? 0;
  return `#${ordinal} (${agScore}/${agMax})`;
}

export default function StudentAssignmentsList() {
  const { identities } = useIdentity();
  const { course_id } = useParams();
  const { role } = useClassProfiles();
  const course = role.classes;
  const [query, setQuery] = useState("");

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

  // Dashboard data via SECURITY DEFINER RPC. The function checks authorization at the
  // top (caller is either the student themselves or an instructor/grader of the class)
  // and returns the student's assignment dashboard rows. Replaces the prior
  // `useList({ resource: "assignments_for_student_dashboard" })` on a view whose
  // security_invoker scoping couldn't accommodate the instructor read-only view-as path.
  const [assignments, setAssignments] = useState<AssignmentsForStudentDashboard[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  useEffect(() => {
    if (!course_id || !private_profile_id) {
      return;
    }
    const supabase = createClient();
    let cancelled = false;
    setIsLoading(true);
    (async () => {
      try {
        const { data, error } = await supabase.rpc("get_assignments_for_student_dashboard", {
          p_class_id: Number(course_id),
          p_student_profile_id: private_profile_id
        });
        if (cancelled) return;
        if (error) {
          // eslint-disable-next-line no-console
          console.error("Failed to load assignments dashboard:", error);
          setAssignments(null);
        } else {
          setAssignments(data ?? []);
        }
      } catch (error) {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error("Failed to load assignments dashboard:", error);
        setAssignments(null);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [course_id, private_profile_id]);

  const githubIdentity: UserIdentity | null = identities?.find((identity) => identity.provider === "github") ?? null;

  const actions = !githubIdentity ? <LinkAccount /> : <></>;

  // The dashboard RPC doesn't carry the advisory suggested_due_date; pull it from the
  // course controller (full assignment rows) and look it up by id when rendering.
  const courseAssignments = useAssignments();
  const suggestedDueDateById = useMemo(
    () => new Map(courseAssignments.map((a) => [a.id, a.suggested_due_date])),
    [courseAssignments]
  );
  const showSuggestedDueDate = useSuggestedDueDateEmphasisEnabled();

  const { workInFuture, workInPast } = useMemo(() => {
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
      // The date this row actually shows as "Due". Ordering and the 24-hour highlight follow it
      // so the list reads in the order students see, rather than by a hard deadline the
      // emphasized layout pushes into the background.
      const suggestedForRow = suggestedDueDateById.get(assignment.id);
      const suggestedTZDate = suggestedForRow
        ? new TZDate(suggestedForRow, course?.time_zone ?? "America/New_York")
        : undefined;
      // Mirrors the fallback inside DueDateDisplay: a suggested date later than this student's
      // effective deadline is not rendered as the due date, so it must not drive ordering or the
      // highlight either.
      const primaryDate =
        showSuggestedDueDate && suggestedTZDate && !(modifiedDueDate && suggestedTZDate > modifiedDueDate)
          ? suggestedTZDate
          : modifiedDueDate;
      result.push({
        key: assignment.id.toString(),
        name: assignment.title!,
        type: "assignment",
        due_date: modifiedDueDate,
        primary_date: primaryDate,
        due_date_component: modifiedDueDate ? (
          <DueDateDisplay
            suggestedDueDate={suggestedForRow}
            showSuggested={showSuggestedDueDate}
            dueDate={modifiedDueDate}
            dueDateNode={<TimeZoneAwareDate date={modifiedDueDate} format="MMM d, h:mm a" />}
          />
        ) : (
          <>-</>
        ),
        repo: repo,
        is_repo_ready: assignment.is_github_ready ?? false,
        name_link: `/course/${course_id}/assignments/${assignment.id}`,
        submission_text: formatLatestSubmissionLabel(assignment),
        submission_link: assignment.submission_id
          ? `/course/${course_id}/assignments/${assignment.id}/submissions/${assignment.submission_id}`
          : undefined,
        group: assignment.group_config === "individual" ? "Individual" : group?.assignment_groups?.name || "No Group"
      });

      if (assignment.self_review_setting_id && assignment.review_assignment_id) {
        const evalDueDate = assignment.due_date
          ? addHours(new Date(assignment.due_date), assignment.self_review_deadline_offset ?? 0)
          : undefined;
        // One instance for both fields: a self review has no suggested date, so its displayed date
        // and its deadline are the same moment and must not be able to drift apart.
        const evalDueTZDate = evalDueDate ? new TZDate(evalDueDate) : undefined;
        result.push({
          key: assignment.id.toString() + "selfReview",
          name: "Self Review for " + assignment.title,
          type: "self review",
          due_date: evalDueTZDate,
          primary_date: evalDueTZDate,
          due_date_component: <SelfReviewDueDate assignment={assignment} />,
          repo: repo,
          is_repo_ready: assignment.is_github_ready ?? false,
          name_link: `/course/${course_id}/assignments/${assignment.id}/submissions/${assignment.review_submission_id}/files?review_assignment_id=${assignment.review_assignment_id}`,
          submission_text: assignment.submission_review_completed_at ? "Submitted" : "Not Submitted",
          group: assignment.group_config === "individual" ? "Individual" : group?.assignment_groups?.name || "No Group"
        });
      }
    });
    // Sort by the date each row displays (the suggested date in emphasized courses, otherwise the
    // effective due date, which includes lab-based scheduling and extensions).
    // `primary_date` is only unset when `due_date` is too, so no fallback chain is needed. These
    // are already TZDate instances; re-wrapping them just to read `getTime()` recomputes the zone
    // offset twice per comparison for no change in the value.
    const nowMs = Date.now();
    const sortedResult = result.sort((a, b) => {
      const dateA = a.primary_date?.getTime() ?? nowMs;
      const dateB = b.primary_date?.getTime() ?? nowMs;
      return dateB - dateA;
    });
    const curTimeInCourseTimezone = new TZDate(new Date(), course?.time_zone ?? "America/New_York");

    // Past/future bucketing intentionally stays on the hard deadline even when the suggested date
    // is emphasized. The buckets answer "can I still act on this?", and an assignment past its
    // suggested date is still submittable and still gradeable until the deadline — filing it under
    // "Past Assignments" would hide exactly the resubmission window this feature exists to
    // support. The row itself shows both dates, so the distinction stays visible.
    return {
      allAssignedWork: sortedResult,
      workInFuture: sortedResult.filter((work) => {
        return work.due_date && work.due_date > curTimeInCourseTimezone;
      }),
      workInPast: sortedResult.filter((work) => {
        return work.due_date && work.due_date < curTimeInCourseTimezone;
      })
    };
  }, [assignments, groups, course, course_id, suggestedDueDateById, showSuggestedDueDate]);

  const filterWork = (rows: AssignmentUnit[]) => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => {
      const haystacks = [row.name, row.repo, row.submission_text, row.group, row.type];
      return haystacks.some((s) => (s ?? "").toLowerCase().includes(q));
    });
  };
  const visibleFuture = filterWork(workInFuture);
  const visiblePast = filterWork(workInPast);

  return (
    <PageContainer maxW="container.lg">
      {actions}
      <ResendOrgInvitation />
      <Heading as="h1" size="lg" mb={4}>
        Assignments
      </Heading>
      <Stack direction={{ base: "column", md: "row" }} gap={2} mb={3} align={{ base: "stretch", md: "center" }}>
        <Box flex="1" maxW={{ base: "100%", md: "360px" }}>
          <InputGroup startElement={<BsSearch aria-hidden />}>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search assignments"
              aria-label="Search assignments"
              data-shortcut="search"
              size="sm"
              _focusVisible={{
                outline: "2px solid",
                outlineColor: "blue.500",
                outlineOffset: "2px",
                borderColor: "blue.500"
              }}
            />
          </InputGroup>
        </Box>
        {query && (
          <Text fontSize="xs" color="fg.muted" aria-live="polite">
            {visibleFuture.length + visiblePast.length} match
            {visibleFuture.length + visiblePast.length === 1 ? "" : "es"}
          </Text>
        )}
      </Stack>
      <Heading as="h2" size="md" mb={2}>
        Upcoming Assignments
      </Heading>
      <ResponsiveTable>
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
          {visibleFuture.length === 0 && !isLoading && (
            <Table.Row>
              <Table.Cell colSpan={5}>
                <EmptyState.Root size="md">
                  <EmptyState.Content>
                    <EmptyState.Indicator>
                      <Icon as={FaCheckCircle} />
                    </EmptyState.Indicator>
                    <EmptyState.Title>
                      {query ? `No upcoming matches for "${query}"` : "No upcoming deadlines available"}
                    </EmptyState.Title>
                    <EmptyState.Description>
                      {query
                        ? "Try a different search term, or clear the filter to see all upcoming work."
                        : "Your instructor may not have released any upcoming assignments yet."}
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
          {visibleFuture.map((work) => {
            // Flag a row when either date it shows is within the next 24 hours: the suggested date
            // students are asked to work to, or the hard deadline after which submissions close.
            // Both bounds matter. Without the lower bound, an emphasized row whose suggested date
            // has passed reports a large negative difference, satisfies `< 24`, and stays flagged
            // for its whole resubmission window; without the hard deadline in the union, that same
            // row loses the cue at the moment the enforced deadline is actually imminent.
            const now = new Date();
            const isCloseDeadline = [work.primary_date, work.due_date].some((date) => {
              if (!date) return false;
              const hoursUntil = differenceInHours(date, now);
              return hoursUntil >= 0 && hoursUntil < 24;
            });
            return (
              <Table.Row
                key={work.key}
                border={isCloseDeadline ? "2px solid" : "none"}
                borderColor={isCloseDeadline ? "border.info" : undefined}
                bg={isCloseDeadline ? "bg.info" : undefined}
              >
                <Table.Cell>{work.due_date_component}</Table.Cell>
                <Table.Cell>
                  <Link href={work.name_link}>{work.name}</Link>
                </Table.Cell>
                <Table.Cell>
                  {work.submission_link ? (
                    <Link href={work.submission_link}>{work.submission_text}</Link>
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
      </ResponsiveTable>
      <Heading as="h2" size="md" mt={6} mb={2}>
        Past Assignments
      </Heading>
      <ResponsiveTable>
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
          {visiblePast.length === 0 && !isLoading && (
            <Table.Row>
              <Table.Cell colSpan={5}>
                <EmptyState.Root size="md">
                  <EmptyState.Content>
                    <EmptyState.Indicator>
                      <Icon as={FaCheckCircle} />
                    </EmptyState.Indicator>
                    <EmptyState.Title>
                      {query ? `No past matches for "${query}"` : "No due dates have passed"}
                    </EmptyState.Title>
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
          {visiblePast.map((work) => {
            return (
              <Table.Row key={work.key}>
                <Table.Cell>{work.due_date_component}</Table.Cell>
                <Table.Cell>
                  <Link href={work.name_link}>{work.name}</Link>
                </Table.Cell>
                <Table.Cell>
                  {work.submission_link ? (
                    <Link href={work.submission_link}>{work.submission_text}</Link>
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
      </ResponsiveTable>
    </PageContainer>
  );
}
