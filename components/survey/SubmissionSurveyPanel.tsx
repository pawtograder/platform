"use client";

import {
  Accordion,
  Badge,
  Box,
  Flex,
  Heading,
  HStack,
  Icon,
  NativeSelect,
  Spinner,
  Text,
  VStack
} from "@chakra-ui/react";
import { formatDistanceToNow, isPast } from "date-fns";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { FaCheckCircle, FaClipboardList, FaMinusCircle, FaRegCircle, FaRegClock } from "react-icons/fa";

import { Alert } from "@/components/ui/alert";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { getStudentFacingErrorMessage } from "@/lib/studentFacingErrorMessages";
import type { SubmissionSurveyResponseRow } from "@/types/survey";
import { createClient } from "@/utils/supabase/client";

const ViewSurveyResponse = dynamic(() => import("@/components/ViewSurveyResponse"), {
  ssr: false,
  loading: () => (
    <Flex align="center" justify="center" p={8}>
      <Spinner size="sm" />
    </Flex>
  )
});

/**
 * Ceiling on how many responses the panel expands on its own. Each expanded response
 * builds a SurveyJS model, so this bounds the work an unusually large roster can cause;
 * it is a safety valve, not a view preference.
 */
const MAX_AUTO_EXPANDED_RESPONSES = 8;

type MemberStatus = "completed" | "in_progress" | "not_started" | "not_assigned";

/** One linked survey with the roster rows the RPC returned for it. */
type SurveyGroup = {
  surveyId: string;
  title: string;
  json: SubmissionSurveyResponseRow["survey_json"];
  status: SubmissionSurveyResponseRow["survey_status"];
  dueDate: string | null;
  availableAt: string | null;
  members: SubmissionSurveyResponseRow[];
};

/**
 * The order of these three checks is load-bearing in both directions.
 *
 * A present `response` wins outright, ahead of `is_assigned`. A member can be assigned,
 * answer, and be unassigned afterwards, and those answers are real work a grader has to be
 * able to read. Labeling that row "Not assigned" would hide it behind a card, which is a
 * worse failure than the mislabeling `is_assigned` exists to fix. Note this reads
 * `response`, not `is_submitted`: `is_submitted` is false for a saved draft and for a row
 * that was never opened alike, so it cannot tell those apart.
 *
 * Among the rows that have no response, `is_assigned === false` comes before "Not started".
 * The survey went out to named assignees and this member was not one of them, so nobody
 * asked them for an answer. Without this check the row reads as "Not started" and invites a
 * grader to penalize a student who was never given the survey. "Not assigned" is only ever
 * an explanation for a missing response, which is why it sits here and not first.
 *
 * A null `response` with `is_assigned` true means the LEFT JOIN found no `survey_responses`
 * row: the member was asked and never opened the survey. That case is the point of the
 * panel, so it never renders as an empty form.
 */
function memberStatus(row: SubmissionSurveyResponseRow): MemberStatus {
  if (row.response != null) {
    return row.is_submitted ? "completed" : "in_progress";
  }
  if (row.is_assigned === false) {
    return "not_assigned";
  }
  return "not_started";
}

/**
 * A not-assigned row has nothing to show and never builds a SurveyJS model. That follows
 * from the ordering in `memberStatus` rather than holding on its own: because a present
 * response is checked first, a row can only reach "not_assigned" with a null `response`, so
 * `status !== "not_assigned"` is exactly "has something to show". Reorder those checks and
 * this predicate stops being true.
 */
function hasExpandableBody(row: SubmissionSurveyResponseRow): boolean {
  return memberStatus(row) !== "not_assigned";
}

const STATUS_LABEL: Record<MemberStatus, string> = {
  completed: "Completed",
  in_progress: "In progress",
  not_started: "Not started",
  not_assigned: "Not assigned"
};

/**
 * Green, yellow and red carry a verdict, and gray is spoken for by "Not started", which is
 * the state this one has to be told apart from. Purple is the remaining palette that reads
 * as a category rather than a grade, which is what "we never asked" is.
 */
const STATUS_PALETTE: Record<MemberStatus, string> = {
  completed: "green",
  in_progress: "yellow",
  not_started: "gray",
  not_assigned: "purple"
};

const STATUS_ICON: Record<MemberStatus, typeof FaCheckCircle> = {
  completed: FaCheckCircle,
  in_progress: FaRegClock,
  not_started: FaRegCircle,
  not_assigned: FaMinusCircle
};

/**
 * Preserves the RPC's order: (survey_title, is_submitter desc, profile_name). On a group
 * submission `is_submitter` is false for everyone, so that sorts to name order.
 */
function groupBySurvey(rows: SubmissionSurveyResponseRow[]): SurveyGroup[] {
  const groups = new Map<string, SurveyGroup>();
  for (const row of rows) {
    const existing = groups.get(row.survey_id);
    if (existing) {
      existing.members.push(row);
    } else {
      groups.set(row.survey_id, {
        surveyId: row.survey_id,
        title: row.survey_title,
        json: row.survey_json,
        status: row.survey_status,
        dueDate: row.due_date,
        availableAt: row.available_at,
        members: [row]
      });
    }
  }
  return Array.from(groups.values());
}

function memberName(row: SubmissionSurveyResponseRow): string {
  return row.profile_name ?? "Unknown student";
}

/**
 * Has the survey's release time passed? This is the availability half of the RPC's
 * non-staff visibility predicate (`available_at IS NULL OR available_at <= now()`), and it
 * is also what the "Not yet open" badge asks. One helper for both so the badge and the
 * view-as narrowing below cannot disagree about whether a survey has opened.
 */
function isAvailableNow(availableAt: string | null): boolean {
  return availableAt == null || isPast(new Date(availableAt));
}

function RosterChip({ row, isOwnRow }: { row: SubmissionSurveyResponseRow; isOwnRow: boolean }) {
  const status = memberStatus(row);
  return (
    <HStack
      data-testid={`survey-member-status-${row.profile_id}`}
      gap={2}
      px={3}
      py={2}
      borderWidth="1px"
      borderColor={isOwnRow ? "border.info" : "border.emphasized"}
      borderRadius="md"
      bg="bg.subtle"
    >
      <Icon as={STATUS_ICON[status]} color={`${STATUS_PALETTE[status]}.fg`} />
      <VStack align="start" gap={0}>
        <Text fontSize="sm" fontWeight="medium">
          {memberName(row)}
          {/* `is_submitter` is true only on a solo submission with an individual owner:
              a group submission has no `submissions.profile_id`, so no row is the
              submitter. Accurate when it fires, silent otherwise. */}
          {row.is_submitter ? " (submitter)" : ""}
        </Text>
        <HStack gap={2}>
          <Badge size="sm" colorPalette={STATUS_PALETTE[status]}>
            {STATUS_LABEL[status]}
          </Badge>
          {isOwnRow && (
            <Badge size="sm" colorPalette="blue" variant="outline">
              Your response
            </Badge>
          )}
          {row.submitted_at && (
            <Text fontSize="xs" color="fg.muted" data-visual-test="transparent" data-visual-placeholder="relative-time">
              {formatDistanceToNow(new Date(row.submitted_at), { addSuffix: true })}
            </Text>
          )}
        </HStack>
      </VStack>
    </HStack>
  );
}

function NotStartedCard({ row, isOwnRow }: { row: SubmissionSurveyResponseRow; isOwnRow: boolean }) {
  return (
    <Box borderWidth="1px" borderColor="border.emphasized" borderRadius="md" bg="bg.subtle" p={4}>
      <Text fontWeight="medium">
        {isOwnRow ? "You have not started this survey." : `${memberName(row)} has not started this survey.`}
      </Text>
      <Text fontSize="sm" color="fg.muted">
        There is no saved response to show. This is not the same as answering nothing.
      </Text>
    </Box>
  );
}

function NotAssignedCard({ row, isOwnRow }: { row: SubmissionSurveyResponseRow; isOwnRow: boolean }) {
  return (
    <Box borderWidth="1px" borderColor="border.emphasized" borderRadius="md" bg="bg.subtle" p={4}>
      <Text fontWeight="medium">
        {isOwnRow ? "You were not assigned this survey." : `${memberName(row)} was not assigned this survey.`}
      </Text>
      <Text fontSize="sm" color="fg.muted">
        There is no response to show, and none was expected.
      </Text>
    </Box>
  );
}

export default function SubmissionSurveyPanel({ submissionId }: { submissionId: number }) {
  const supabase = useMemo(() => createClient(), []);
  // "Whose row is this" is the useful distinction, and it works for both shapes: a student
  // has exactly one row and it is theirs, a grader has none of their own. Responses are
  // written under the private profile id (the survey page upserts that), and so is the
  // roster, so this is the right id to compare.
  const { private_profile_id: viewerProfileId, isReadOnly: isViewingAsStudent } = useClassProfiles();
  const [rows, setRows] = useState<SubmissionSurveyResponseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSurveyId, setSelectedSurveyId] = useState<string | null>(null);
  const [openMembers, setOpenMembers] = useState<string[]>([]);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      const { data, error: rpcError } = await supabase.rpc("get_survey_responses_for_submission", {
        p_submission_id: submissionId
      });
      if (!mounted) {
        return;
      }
      if (rpcError) {
        setError(getStudentFacingErrorMessage(rpcError));
        setRows([]);
      } else {
        setRows(data ?? []);
      }
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, [supabase, submissionId]);

  // `useClassProfiles` hands back the EFFECTIVE profile, so under "view as student"
  // `viewerProfileId` is the impersonated student while the Supabase request still
  // authenticates as the staff member who started the preview. The RPC answers the staff
  // caller, so it returns rows a real student's own call would never have produced, and the
  // preview would otherwise draw them under that student's name. Two different disclosures,
  // so two legs, both needed:
  //
  //   1. Every roster member's row comes back, including teammates' peer-evaluation
  //      answers. Keep only the impersonated profile's own row, which is the one row per
  //      survey a student receives.
  //   2. Every survey linked to the assignment comes back, including ones withheld from
  //      students: unreleased, or assigned to named students this one is not among. Those
  //      carry `survey_json`, the question text, so rendering one leaks an unreleased
  //      survey onto a screen-share. Row presence cannot detect this, because the
  //      staff-scoped RPC returns a row for the impersonated profile on those surveys too.
  //      The predicate has to be reproduced instead: the survey has opened, and this
  //      profile was assigned it.
  //
  // Leg 2 mirrors the non-staff branch of the RPC's own visibility test (`available_at IS
  // NULL OR available_at <= now()` AND `is_assigned`). This is preview fidelity, not a
  // security control: the RPC decides what this staff member may read, and nothing here
  // changes that. What it decides is what the preview is honest in drawing. Because it is a
  // copy of a server predicate, it can drift from it. Change that branch of the RPC and
  // change this filter in the same pass.
  //
  // Both legs land in this one derivation, so the surfaces below (the survey picker, the
  // roster strip, the accordion, the auto-expand set) all read the same narrowed list and
  // cannot fall out of step with each other.
  const visibleRows = useMemo(() => {
    if (!isViewingAsStudent) {
      return rows;
    }
    return rows.filter(
      (row) => row.profile_id === viewerProfileId && isAvailableNow(row.available_at) && row.is_assigned
    );
  }, [rows, isViewingAsStudent, viewerProfileId]);

  const surveys = useMemo(() => groupBySurvey(visibleRows), [visibleRows]);
  const selected = useMemo(
    () => surveys.find((s) => s.surveyId === selectedSurveyId) ?? surveys[0] ?? null,
    [surveys, selectedSurveyId]
  );

  // Open every answered response for whichever survey is showing: on a group submission
  // the whole roster is what the grader came to read, and one click per teammate is
  // friction on the main path. Members who never started stay collapsed — their trigger
  // already says "Not started" and there is no response to show. Collapsed items render
  // nothing (see below), so this is also the set of SurveyJS models that get built.
  useEffect(() => {
    if (!selected) {
      setOpenMembers([]);
      return;
    }
    // A member who was never assigned the survey stays collapsed in every branch below: the
    // row has no answers to read and no absence to account for, so opening it would give a
    // non-event the same weight as a missed one.
    const expandable = selected.members.filter(hasExpandableBody);
    // The cap counts only answered rows, because those are the ones that cost anything: a
    // not-started row's body is a static card, not a SurveyJS model. Leaving those collapsed
    // hid the card behind a click and left "never started" readable only as a badge, so they
    // expand too.
    const answered = expandable.filter((m) => m.response != null);
    if (answered.length <= MAX_AUTO_EXPANDED_RESPONSES) {
      setOpenMembers(expandable.map((m) => m.profile_id));
      return;
    }
    // Groups run 2-5 members, so this branch guards an unusually large roster rather than
    // expressing a preference: past the cap, open one response instead of dozens. Prefer
    // the viewer's own row, then anyone who answered, then whatever came first.
    const primary =
      expandable.find((m) => m.profile_id === viewerProfileId) ??
      expandable.find((m) => m.response != null) ??
      expandable[0];
    setOpenMembers(primary ? [primary.profile_id] : []);
  }, [selected, viewerProfileId]);

  if (loading) {
    return (
      <Flex data-testid="submission-survey-panel" justify="center" py={8}>
        <Spinner size="xl" />
      </Flex>
    );
  }

  if (error) {
    return (
      <Box data-testid="submission-survey-panel" p={4}>
        <Alert status="error" title="Could not load survey responses">
          {error}
        </Alert>
      </Box>
    );
  }

  if (!selected) {
    // Either leg of the narrowing can empty a panel the grader view would have filled, and
    // the generic message then reads as a panel that failed to load. Three ways in: staff
    // are not group members, so a self-preview matches no row; a previewed student may have
    // no row on this submission; and every linked survey may be one students cannot see yet.
    // The message covers all three by naming visibility rather than a missing response, and
    // distinguishes them from a submission with no linked surveys at all.
    const emptiedByPreview = isViewingAsStudent && rows.length > 0;
    return (
      <Box data-testid="submission-survey-panel" textAlign="center" py={8}>
        <Text color="fg.muted">
          {emptiedByPreview
            ? "This is the student view. No survey on this submission is visible to the profile you are previewing."
            : "No survey responses to show for this submission."}
        </Text>
      </Box>
    );
  }

  const notYetOpen = !isAvailableNow(selected.availableAt);

  return (
    <VStack data-testid="submission-survey-panel" align="stretch" gap={4} p={4}>
      <Flex align="center" justify="space-between" gap={4} wrap="wrap">
        <HStack gap={2}>
          <Icon as={FaClipboardList} color="fg.muted" />
          <Heading size="md">{selected.title}</Heading>
          {notYetOpen && <Badge colorPalette="orange">Not yet open</Badge>}
          {selected.status === "closed" && <Badge colorPalette="gray">Closed</Badge>}
        </HStack>
        {surveys.length > 1 && (
          <NativeSelect.Root width="auto" size="sm">
            <NativeSelect.Field
              aria-label="Survey"
              value={selected.surveyId}
              onChange={(e) => setSelectedSurveyId(e.currentTarget.value)}
            >
              {surveys.map((s) => (
                <option key={s.surveyId} value={s.surveyId}>
                  {s.title}
                </option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        )}
      </Flex>

      {selected.dueDate && (
        <Text fontSize="sm" color="fg.muted" data-visual-test="transparent" data-visual-placeholder="relative-time">
          Due {formatDistanceToNow(new Date(selected.dueDate), { addSuffix: true })}
        </Text>
      )}

      {/* A student caller gets back only their own row, and `visibleRows` gives the
          view-as preview the same shape. One chip is that student's own status, not a group
          roster, so the roster heading appears only once there is a roster to summarize.
          Branching on the viewer's role here would duplicate a decision already made twice
          over, by the RPC and by the narrowing above. */}
      <VStack align="stretch" gap={2}>
        {selected.members.length > 1 && (
          <Text fontSize="sm" fontWeight="medium" color="fg.muted">
            Group roster
          </Text>
        )}
        <Flex gap={3} wrap="wrap">
          {selected.members.map((row) => (
            <RosterChip key={row.profile_id} row={row} isOwnRow={row.profile_id === viewerProfileId} />
          ))}
        </Flex>
      </VStack>

      <Accordion.Root
        multiple
        value={openMembers}
        onValueChange={(details) => setOpenMembers(details.value)}
        variant="outline"
      >
        {selected.members.map((row) => {
          const status = memberStatus(row);
          const isOpen = openMembers.includes(row.profile_id);
          return (
            <Accordion.Item
              key={row.profile_id}
              value={row.profile_id}
              data-testid={`survey-response-${row.profile_id}`}
            >
              <Accordion.ItemTrigger>
                <HStack flex="1" gap={3}>
                  <Text fontWeight="medium">
                    {row.profile_id === viewerProfileId ? `Your response (${memberName(row)})` : memberName(row)}
                  </Text>
                  <Badge size="sm" colorPalette={STATUS_PALETTE[status]}>
                    {STATUS_LABEL[status]}
                  </Badge>
                </HStack>
                <Accordion.ItemIndicator />
              </Accordion.ItemTrigger>
              <Accordion.ItemContent>
                <Accordion.ItemBody>
                  {/* Rendered only while open: a SurveyJS model is expensive, and a group
                      of ten would otherwise build ten of them to show one. */}
                  {/* A not-assigned row never auto-expands, but it can still be opened by
                      hand, and when it is it gets the card rather than a form. `memberStatus`
                      only returns "not_assigned" for a row with no response, so this branch
                      can never swallow real answers. */}
                  {isOpen &&
                    (status === "not_assigned" ? (
                      <NotAssignedCard row={row} isOwnRow={row.profile_id === viewerProfileId} />
                    ) : status === "not_started" || row.response == null ? (
                      <NotStartedCard row={row} isOwnRow={row.profile_id === viewerProfileId} />
                    ) : (
                      <ViewSurveyResponse surveyJson={selected.json} responseData={row.response} readOnly />
                    ))}
                </Accordion.ItemBody>
              </Accordion.ItemContent>
            </Accordion.Item>
          );
        })}
      </Accordion.Root>
    </VStack>
  );
}
