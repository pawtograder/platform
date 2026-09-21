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
import { FaCheckCircle, FaClipboardList, FaRegCircle, FaRegClock } from "react-icons/fa";

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

type MemberStatus = "completed" | "in_progress" | "not_started";

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
 * A null `response` means the LEFT JOIN found no `survey_responses` row: the member never
 * opened the survey. That case is the point of the panel, so it never renders as an empty
 * form. `is_submitted` alone cannot tell it apart from a saved draft — it is false for
 * both — so the null check comes first.
 */
function memberStatus(row: SubmissionSurveyResponseRow): MemberStatus {
  if (row.response == null) {
    return "not_started";
  }
  return row.is_submitted ? "completed" : "in_progress";
}

const STATUS_LABEL: Record<MemberStatus, string> = {
  completed: "Completed",
  in_progress: "In progress",
  not_started: "Not started"
};

const STATUS_PALETTE: Record<MemberStatus, string> = {
  completed: "green",
  in_progress: "yellow",
  not_started: "gray"
};

const STATUS_ICON: Record<MemberStatus, typeof FaCheckCircle> = {
  completed: FaCheckCircle,
  in_progress: FaRegClock,
  not_started: FaRegCircle
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

export default function SubmissionSurveyPanel({ submissionId }: { submissionId: number }) {
  const supabase = useMemo(() => createClient(), []);
  // "Whose row is this" is the useful distinction, and it works for both shapes: a student
  // has exactly one row and it is theirs, a grader has none of their own. Responses are
  // written under the private profile id (the survey page upserts that), and so is the
  // roster, so this is the right id to compare.
  const { private_profile_id: viewerProfileId } = useClassProfiles();
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

  const surveys = useMemo(() => groupBySurvey(rows), [rows]);
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
    // The cap counts only answered rows, because those are the ones that cost anything: a
    // not-started row's body is a static card, not a SurveyJS model. Leaving those collapsed
    // hid the card behind a click and left "never started" readable only as a badge, so they
    // expand too.
    const answered = selected.members.filter((m) => m.response != null);
    if (answered.length <= MAX_AUTO_EXPANDED_RESPONSES) {
      setOpenMembers(selected.members.map((m) => m.profile_id));
      return;
    }
    // Groups run 2-5 members, so this branch guards an unusually large roster rather than
    // expressing a preference: past the cap, open one response instead of dozens. Prefer
    // the viewer's own row, then anyone who answered, then whatever came first.
    const primary =
      selected.members.find((m) => m.profile_id === viewerProfileId) ??
      selected.members.find((m) => m.response != null) ??
      selected.members[0];
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
    return (
      <Box data-testid="submission-survey-panel" textAlign="center" py={8}>
        <Text color="fg.muted">No survey responses to show for this submission.</Text>
      </Box>
    );
  }

  const notYetOpen = selected.availableAt != null && !isPast(new Date(selected.availableAt));

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

      {/* A student caller gets back only their own row. One chip is that student's own
          status, not a group roster, so the roster heading appears only once there is a
          roster to summarize — the alternative, branching on the viewer's role, would
          duplicate what the RPC already decided. */}
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
                  {isOpen &&
                    (status === "not_started" || row.response == null ? (
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
