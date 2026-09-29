"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { submitReport, type ReportReplayUpload, type SubmitReportResult } from "@/lib/bugReport/submitFeedback";
import { Box, Code, Text, Textarea, VStack } from "@chakra-ui/react";
import { useAnnouncer } from "@/components/ui/live-announcer";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The replay half of the dialog. The provider passes it only when a recording is available
 * (course flag on, route listed, recorder running); with it absent the dialog files feedback
 * without a replay (ADR 4).
 */
export type ReportReplaySlot = {
  /**
   * Review UI: player on the redacted events, remaining-strings list, click-to-redact,
   * keep-last-N-minutes. Rendered after the contact checkbox so the tab order is
   * description, contact, review controls, Cancel, Submit.
   */
  review: ReactNode;
  /**
   * Called on Submit, before the feedback is sent. Null when the review has nothing to attach
   * (redaction failed): the dialog then files the report without a replay and without the
   * recording notice.
   */
  upload: ReportReplayUpload | null;
};

export type ReportBugDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Sentry event ID of the error being reported, when opened from one. */
  eventId?: string;
  replay?: ReportReplaySlot | null;
};

/** ADR 4 notice, shown only when a replay is attached. */
export const REPLAY_NOTICE = "This report includes a redacted recording of your last few minutes on this page";

const SENT_MESSAGE = "Thanks, your report was sent.";

type Phase =
  | { kind: "editing" }
  | { kind: "submitting" }
  | { kind: "sent" }
  | { kind: "rate_limited" }
  | { kind: "error"; message: string };

/**
 * On close, focus goes back to what opened the dialog. When that element is gone (the toast
 * whose "Report this" opened it has been dismissed) or was <body>, it goes to the page's main
 * landmark instead, so keyboard users don't land on <body>.
 */
function fallbackFocusTarget(): HTMLElement | null {
  return document.getElementById("main-content") ?? document.querySelector<HTMLElement>("main, [role='main']");
}

export function ReportBugDialog({ open, onOpenChange, eventId, replay }: ReportBugDialogProps) {
  const [description, setDescription] = useState("");
  const [contactOk, setContactOk] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });
  const [showRequired, setShowRequired] = useState(false);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  // Where focus was when the dialog opened, to return it there on close. Read during the render
  // that opens the dialog, before the dialog's focus trap moves focus.
  const openerRef = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== "undefined") openerRef.current = document.activeElement;
  wasOpen.current = open;
  const announce = useAnnouncer();
  const returnFocusTarget = useCallback((): HTMLElement | null => {
    const opener = openerRef.current;
    if (opener instanceof HTMLElement && opener.isConnected && opener !== document.body) return opener;
    return fallbackFocusTarget();
  }, []);

  // Each opening starts from a blank form. Nothing typed is kept or sent after Cancel.
  useEffect(() => {
    if (open) {
      setDescription("");
      // The field is uncontrolled (see below); clear it directly.
      if (descriptionRef.current) descriptionRef.current.value = "";
      setContactOk(false);
      setPhase({ kind: "editing" });
      setShowRequired(false);
    }
  }, [open, eventId]);

  // The controls are disabled while sending, which drops focus. Put it back somewhere useful.
  useEffect(() => {
    if (phase.kind === "sent") doneRef.current?.focus();
    else if (phase.kind === "error" || phase.kind === "rate_limited") submitRef.current?.focus();
  }, [phase.kind]);

  const handleSubmit = useCallback(async () => {
    if (!description.trim()) {
      setShowRequired(true);
      descriptionRef.current?.focus();
      return;
    }
    setPhase({ kind: "submitting" });
    let result: SubmitReportResult;
    try {
      result = await submitReport({ description, contactOk, eventId, replay: replay?.upload ?? undefined });
    } catch {
      result = { status: "error", message: "The report did not go through. Try again." };
    }
    if (result.status === "sent") {
      setPhase({ kind: "sent" });
      announce(SENT_MESSAGE);
    } else if (result.status === "rate_limited") setPhase({ kind: "rate_limited" });
    else setPhase({ kind: "error", message: result.message });
  }, [announce, contactOk, description, eventId, replay]);

  const submitting = phase.kind === "submitting";
  const sent = phase.kind === "sent";

  return (
    <DialogRoot
      open={open}
      onOpenChange={(e) => {
        // Don't let Escape or the backdrop drop a report that is mid-send.
        if (!e.open && submitting) return;
        onOpenChange(e.open);
      }}
      // Whichever exists: Close once sent, else the description. The focus trap also calls this
      // when the focused element leaves the DOM (Submit swapped for Close, a redacted string's
      // button), sometimes with a stale closure, and throws if it gets null.
      initialFocusEl={() => doneRef.current ?? descriptionRef.current ?? submitRef.current}
      finalFocusEl={returnFocusTarget}
      closeOnInteractOutside={!submitting}
      size={{ base: "full", md: replay ? "lg" : "md" }}
      scrollBehavior="inside"
    >
      <DialogContent data-testid="report-bug-dialog">
        <DialogHeader>
          <DialogTitle>Report a bug</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {sent ? (
            <Box data-testid="report-bug-sent">
              <Text fontWeight="semibold">{SENT_MESSAGE}</Text>
              <Text color="fg.muted" mt={1}>
                The developers will look into it.
              </Text>
            </Box>
          ) : (
            <VStack gap={4} align="stretch">
              <DialogDescription color="fg.muted">
                Tell us what you were doing and what went wrong. The report includes your user ID, your course role, and
                the page you are on. It does not include your name or email.
              </DialogDescription>
              {eventId && (
                <Text fontSize="sm" data-testid="report-bug-linked-event">
                  Linked error ID:{" "}
                  <Code wordBreak="break-all" data-testid="report-bug-event-id">
                    {eventId}
                  </Code>
                </Text>
              )}
              <Field
                label="What happened?"
                required
                invalid={showRequired && !description.trim()}
                errorText="Describe the problem before sending."
              >
                {/* Uncontrolled: while the replay review loads, the dialog re-renders often, and a
                    controlled field dropped keystrokes typed during those renders (seen in E6). */}
                <Textarea
                  ref={descriptionRef}
                  defaultValue=""
                  onChange={(e) => setDescription(e.target.value)}
                  rows={5}
                  disabled={submitting}
                  name="description"
                />
              </Field>
              <Checkbox
                checked={contactOk}
                onCheckedChange={(e) => setContactOk(e.checked === true)}
                disabled={submitting}
              >
                You may contact me about this
              </Checkbox>
              {replay && (
                <>
                  {replay.upload && (
                    <Text fontSize="sm" data-testid="report-bug-replay-notice">
                      {REPLAY_NOTICE}
                    </Text>
                  )}
                  <Box data-testid="report-bug-replay-section">{replay.review}</Box>
                </>
              )}
              {phase.kind === "rate_limited" && (
                <Text role="alert" color="fg.error" data-testid="report-bug-rate-limited">
                  Too many reports are being sent right now. Try again later.
                </Text>
              )}
              {phase.kind === "error" && (
                <Text role="alert" color="fg.error" data-testid="report-bug-error">
                  {phase.message}
                </Text>
              )}
            </VStack>
          )}
        </DialogBody>
        <DialogFooter>
          {sent ? (
            <Button ref={doneRef} onClick={() => onOpenChange(false)}>
              Close
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button ref={submitRef} onClick={handleSubmit} loading={submitting} loadingText="Sending">
                Submit
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
