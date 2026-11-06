"use client";

import { Button } from "@/components/ui/button";
import { toaster } from "@/components/ui/toaster";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useFeatureEnabled } from "@/hooks/useCourseFeatures";
import { useHelpRequestEscalationActions } from "@/hooks/useHelpRequestEscalationActions";
import { useHelpRequestStudents, useStudentVisibleHelpRequests } from "@/hooks/useOfficeHoursRealtime";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { COURSE_FEATURES } from "@/lib/courseFeatures";
import { isCheckInPending, isValidEscalationNote } from "@/lib/helpRequestEscalation";
import { Box, Dialog, HStack, Icon, Stack, Text } from "@chakra-ui/react";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { BsCheckCircle, BsXCircle } from "react-icons/bs";
import { EscalationNoteField } from "./escalate-dialog";

const HelpRequestFeedbackModal = dynamic(() => import("@/components/help-queue/help-request-feedback-modal"), {
  ssr: false
});

const RECHECK_INTERVAL_MS = 15_000;

/**
 * "Did your problem get fixed?" check-in, shown to a student after staff press Resolve on their
 * ticket. It is the only way a student can escalate, so escalation can't be used to skip the line.
 * Mounted once in the course layout so it appears on any course page. It has no close button: the
 * student answers, or the check-in window lapses and the ticket stays resolved.
 */
export function EscalationCheckInDialog() {
  const { role, private_profile_id, isReadOnly } = useClassProfiles();
  const featureEnabled = useFeatureEnabled(COURSE_FEATURES.OFFICE_HOURS);
  if (role.role !== "student" || !featureEnabled || isReadOnly || !private_profile_id) return null;
  return <CheckInForStudent profileId={private_profile_id} classId={role.class_id} />;
}

function CheckInForStudent({ profileId, classId }: { profileId: string; classId: number }) {
  const helpRequests = useStudentVisibleHelpRequests();
  const helpRequestStudents = useHelpRequestStudents();
  const [now, setNow] = useState(() => Date.now());
  const [feedbackRequestId, setFeedbackRequestId] = useState<number | null>(null);

  // The window expires on the clock, not on a data change, so re-evaluate periodically.
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), RECHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const pending = useMemo(() => {
    const mine = new Set(helpRequestStudents.filter((s) => s.profile_id === profileId).map((s) => s.help_request_id));
    // Soonest-expiring first, so one check-in can't hold the dialog while another lapses unseen.
    return (
      helpRequests
        .filter((r) => mine.has(r.id) && isCheckInPending(r, now))
        .sort((a, b) => new Date(a.check_in_expires_at!).getTime() - new Date(b.check_in_expires_at!).getTime())[0] ??
      null
    );
  }, [helpRequests, helpRequestStudents, profileId, now]);

  return (
    <>
      {/* One dialog at a time: the next check-in waits until the feedback prompt closes. */}
      {pending && feedbackRequestId === null && (
        <CheckInDialog
          key={pending.id}
          requestId={pending.id}
          helperId={pending.assignee ?? pending.resolved_by}
          onFixed={() => setFeedbackRequestId(pending.id)}
        />
      )}
      {feedbackRequestId !== null && (
        <HelpRequestFeedbackModal
          isOpen
          onClose={() => setFeedbackRequestId(null)}
          onSuccess={() => setFeedbackRequestId(null)}
          helpRequestId={feedbackRequestId}
          classId={classId}
          studentProfileId={profileId}
        />
      )}
    </>
  );
}

function CheckInDialog({
  requestId,
  helperId,
  onFixed
}: {
  requestId: number;
  helperId: string | null;
  onFixed: () => void;
}) {
  const helper = useUserProfile(helperId);
  const helperName = helper?.name ?? "Your TA";
  const { answerCheckIn } = useHelpRequestEscalationActions();
  const [answer, setAnswer] = useState<"fixed" | "not_fixed" | null>(null);
  const [note, setNote] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (answer === "not_fixed") {
      setAttempted(true);
      if (!isValidEscalationNote(note)) return;
    }
    setSubmitting(true);
    const ok = await answerCheckIn(requestId, answer === "fixed", answer === "fixed" ? undefined : note);
    setSubmitting(false);
    if (!ok) return;
    if (answer === "fixed") {
      onFixed();
    } else {
      toaster.success({
        title: "Request escalated",
        description: "You're back in the queue ahead of new requests."
      });
    }
  };

  return (
    <Dialog.Root open size="md" closeOnInteractOutside={false} closeOnEscape={false}>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Did your problem get fixed?</Dialog.Title>
          </Dialog.Header>
          <Dialog.Body>
            <Stack gap="6">
              <Text fontSize="sm" color="fg.muted">
                {helperName} has finished helping you.
              </Text>
              <HStack justify="center" gap={8} wrap="wrap">
                <Button
                  size="lg"
                  variant={answer === "fixed" ? "solid" : "outline"}
                  colorPalette={answer === "fixed" ? "green" : "gray"}
                  onClick={() => setAnswer("fixed")}
                  type="button"
                  aria-pressed={answer === "fixed"}
                  p={8}
                  flexDirection="column"
                  height="auto"
                  minHeight="100px"
                  width="140px"
                >
                  <Icon as={BsCheckCircle} fontSize="2xl" mb={2} />
                  <Text fontSize="sm" fontWeight="medium">
                    Yes, I&apos;m done
                  </Text>
                </Button>
                <Button
                  size="lg"
                  variant={answer === "not_fixed" ? "solid" : "outline"}
                  colorPalette={answer === "not_fixed" ? "purple" : "gray"}
                  onClick={() => setAnswer("not_fixed")}
                  type="button"
                  aria-pressed={answer === "not_fixed"}
                  p={8}
                  flexDirection="column"
                  height="auto"
                  minHeight="100px"
                  width="140px"
                >
                  <Icon as={BsXCircle} fontSize="2xl" mb={2} />
                  <Text fontSize="sm" fontWeight="medium">
                    No, still stuck
                  </Text>
                </Button>
              </HStack>

              {answer === "fixed" && (
                <Box p={4} borderRadius="md" borderWidth="1px">
                  <Text fontSize="sm">Your request stays closed and you&apos;ll leave the queue.</Text>
                </Box>
              )}
              {answer === "not_fixed" && (
                <Stack gap="3">
                  <Box p={4} borderRadius="md" borderWidth="1px" borderColor="purple.muted" bg="purple.subtle">
                    <Text fontSize="sm">
                      Your request goes back to the queue ahead of new requests, so you won&apos;t start over at the
                      back. The next TA will see your note and what {helperName} already covered.
                    </Text>
                  </Box>
                  <EscalationNoteField
                    label="What are you still stuck on?"
                    placeholder="The part that still doesn't make sense..."
                    note={note}
                    setNote={setNote}
                    showError={attempted}
                  />
                </Stack>
              )}
            </Stack>
          </Dialog.Body>
          <Dialog.Footer>
            <Button
              colorPalette={answer === "not_fixed" ? "purple" : "green"}
              disabled={answer === null}
              loading={submitting}
              onClick={handleSubmit}
            >
              {answer === "not_fixed" ? "Escalate my request" : "Close my request"}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
