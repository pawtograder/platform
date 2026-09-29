"use client";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useAnnouncer } from "@/components/ui/live-announcer";
import { getActiveRecorder, subscribeActiveRecorder } from "@/lib/bugReport/activeRecorder";
import type { RedactionResult, RemainingKind, RemainingString } from "@/lib/bugReport/redaction/types";
import type { ReplayUploadResult, ReportReplayUpload } from "@/lib/bugReport/submitFeedback";
import type { BugReportRecorder, FrozenBuffer, RecordedEvent } from "@/lib/bugReport/types";
import { Box, Heading, List, NativeSelect, Progress, Stack, Text } from "@chakra-ui/react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ReplayPreview } from "./ReplayPreview";

/**
 * The replay half of the report dialog (spec §5, package 5): freeze the recorder's buffer when
 * the dialog opens, redact the copy in the worker, and let the user review exactly what will be
 * uploaded. Nothing here sends anything; `upload` runs only when the user presses Submit, and it
 * uploads the latest redacted copy, never the frozen original.
 *
 * The redaction module and the upload module are imported on demand, so neither (nor the
 * player, see ReplayPreview) is part of the main bundle.
 */

export type ReplayReviewSlot = {
  review: ReactNode;
  /** Null when there is no redacted recording to attach (redaction failed). */
  upload: ReportReplayUpload | null;
};

type Pass =
  | { kind: "redacting"; stage: "loading" | "redacting" }
  | { kind: "ready"; result: RedactionResult }
  | { kind: "error" };

type Session = {
  buffer: FrozenBuffer;
  /** performance.now() when the dialog opened. */
  openedAt: number;
};

/** Group order and headings of the remaining-strings list (E2). */
const KIND_LABELS: Record<RemainingKind, string> = {
  text: "Page text",
  attribute: "Labels, titles, and links",
  input: "Typed input",
  title: "Page titles",
  url: "Page addresses",
  console: "Console messages",
  breadcrumb: "Activity log"
};
const KIND_ORDER = Object.keys(KIND_LABELS) as RemainingKind[];

const MINUTE = 60_000;

/** Shown when the taint set hit a size budget, so some names may have been missed. */
export const TAINT_SATURATED_WARNING =
  "Some names on this page may not be redacted in the recording. Review it carefully, or remove the recording.";

/** The active recorder, if any, kept current as it starts and stops. */
function useActiveRecorder(): BugReportRecorder | undefined {
  const [recorder, setRecorder] = useState<BugReportRecorder | undefined>(() => getActiveRecorder());
  useEffect(() => subscribeActiveRecorder(setRecorder), []);
  return recorder;
}

/**
 * Returns the dialog's replay slot while `open` and a recording is running on this route, and
 * null otherwise (flag off, route unlisted, or the dialog closed). Closing drops the frozen
 * buffer and every redacted copy; the recorder itself keeps running.
 */
export function useReplayReview(open: boolean): ReplayReviewSlot | null {
  const recorder = useActiveRecorder();
  const [session, setSession] = useState<Session | null>(null);
  const [extraRedactions, setExtraRedactions] = useState<string[]>([]);
  const [keepLastMinutes, setKeepLastMinutes] = useState<number | null>(null);
  const [pass, setPass] = useState<Pass>({ kind: "redacting", stage: "loading" });
  const [previewMs, setPreviewMs] = useState<number | null>(null);
  const [saturated, setSaturated] = useState(false);
  const latest = useRef<Promise<RedactionResult> | null>(null);
  const seq = useRef(0);

  // Freeze once per opening. Recording continues; the dialog works on the copy.
  useEffect(() => {
    if (!open) {
      setSession(null);
      latest.current = null;
      seq.current++;
      return;
    }
    const r = getActiveRecorder();
    if (!r || r.getState() !== "recording") {
      setSession(null);
      return;
    }
    const openedAt = performance.now();
    let buffer: FrozenBuffer;
    try {
      buffer = r.freeze();
    } catch {
      setSession(null);
      return;
    }
    if (buffer.segments.length === 0) {
      setSession(null);
      return;
    }
    setExtraRedactions([]);
    setKeepLastMinutes(null);
    setPreviewMs(null);
    setSaturated(false);
    setSession({ buffer, openedAt });
    // Only the recorder's state at open counts: one that starts while the dialog is open
    // doesn't attach a replay mid-review.
  }, [open]);

  // A recorder that stops while the dialog is open (flag turned off, course left) takes the
  // replay with it.
  useEffect(() => {
    if (session && !recorder) {
      setSession(null);
      latest.current = null;
      seq.current++;
    }
  }, [recorder, session]);

  // Run the redaction pass on the frozen copy, again on every click-to-redact or keep-last-N
  // change. Only the newest pass counts.
  useEffect(() => {
    if (!session) return;
    const id = ++seq.current;
    setPass({ kind: "redacting", stage: "loading" });
    const run = (async () => {
      const redaction = await import("@/lib/bugReport/redaction");
      if (id === seq.current) setPass({ kind: "redacting", stage: "redacting" });
      const taintPatterns = redaction.taintSnapshot();
      // Read after the snapshot, which expands any queued free text: that is what fills a budget.
      if (id === seq.current) setSaturated(getActiveRecorder()?.isTaintSaturated() ?? false);
      return redaction.redactBuffer(session.buffer, {
        taintPatterns,
        extraRedactions,
        keepLastMs: keepLastMinutes === null ? undefined : keepLastMinutes * MINUTE
      });
    })();
    latest.current = run;
    run.then(
      (result) => {
        if (id === seq.current) setPass({ kind: "ready", result });
      },
      () => {
        if (id === seq.current) {
          latest.current = null;
          setPass({ kind: "error" });
        }
      }
    );
  }, [session, extraRedactions, keepLastMinutes]);

  const onFirstFrame = useCallback(() => {
    setPreviewMs((ms) => (ms === null && session ? Math.round(performance.now() - session.openedAt) : ms));
  }, [session]);

  const upload = useMemo<ReportReplayUpload | null>(() => {
    if (!session || pass.kind === "error") return null;
    return {
      async upload(tags): Promise<ReplayUploadResult> {
        const pending = latest.current;
        if (!pending) return { ok: false, reason: "failed" };
        let redacted: RedactionResult;
        try {
          redacted = await pending;
        } catch {
          // Never fall back to the unredacted buffer.
          return { ok: false, reason: "failed" };
        }
        const { createReplayUpload } = await import("@/lib/bugReport/upload");
        return createReplayUpload(redacted.buffer).upload(tags);
      }
    };
  }, [session, pass.kind]);

  if (!open || !session) return null;

  return {
    upload,
    review: (
      <ReplayReviewSection
        buffer={session.buffer}
        pass={pass}
        previewMs={previewMs}
        saturated={saturated}
        onFirstFrame={onFirstFrame}
        extraRedactions={extraRedactions}
        onRedact={(value) => setExtraRedactions((list) => (list.includes(value) ? list : [...list, value]))}
        keepLastMinutes={keepLastMinutes}
        onKeepLastMinutes={setKeepLastMinutes}
      />
    )
  };
}

type SectionProps = {
  buffer: FrozenBuffer;
  pass: Pass;
  previewMs: number | null;
  /** The taint set dropped patterns (`BugReportRecorder.isTaintSaturated`): warn. */
  saturated: boolean;
  onFirstFrame: () => void;
  extraRedactions: string[];
  onRedact: (value: string) => void;
  keepLastMinutes: number | null;
  onKeepLastMinutes: (minutes: number | null) => void;
};

function ReplayReviewSection({
  buffer,
  pass,
  previewMs,
  saturated,
  onFirstFrame,
  extraRedactions,
  onRedact,
  keepLastMinutes,
  onKeepLastMinutes
}: SectionProps) {
  const listId = useId();
  const warningId = useId();
  const [lastResult, setLastResult] = useState<RedactionResult | null>(null);
  useEffect(() => {
    if (pass.kind === "ready") setLastResult(pass.result);
    else if (pass.kind === "error") setLastResult(null);
  }, [pass]);

  // While a re-run is in flight, keep showing the previous result (minus what was just
  // redacted) instead of flashing back to the loading state.
  const shown = pass.kind === "ready" ? pass.result : lastResult;
  const events = useMemo<RecordedEvent[]>(() => (shown ? shown.buffer.segments.flatMap((s) => s.events) : []), [shown]);
  const totalMinutes = Math.max(1, Math.ceil((buffer.endTimestamp - buffer.startTimestamp) / MINUTE));

  return (
    <Stack
      gap={4}
      data-testid="report-bug-replay-review"
      data-status={pass.kind}
      data-preview-ms={previewMs ?? undefined}
      data-event-count={events.length}
    >
      {pass.kind === "error" ? (
        <Text role="alert" color="fg.error" data-testid="report-bug-replay-error">
          The recording could not be redacted, so it will not be attached. You can still send your report without it.
        </Text>
      ) : !shown ? (
        <RedactionProgress stage={pass.kind === "redacting" ? pass.stage : "redacting"} />
      ) : (
        <>
          <ReplayPreview
            events={events}
            describedBy={saturated ? `${warningId} ${listId}` : listId}
            onFirstFrame={onFirstFrame}
          />
          {saturated && (
            // A status region, so it is read with the review when it appears, and it describes
            // the preview too.
            <Text
              id={warningId}
              role="status"
              fontSize="sm"
              color="fg.warning"
              data-testid="report-bug-taint-saturated"
            >
              {TAINT_SATURATED_WARNING}
            </Text>
          )}
          {pass.kind === "redacting" && (
            <Text fontSize="sm" color="fg.muted" role="status">
              Updating the recording
            </Text>
          )}
          <RemainingList
            id={listId}
            remaining={shown.remaining}
            extraRedactions={extraRedactions}
            onRedact={onRedact}
          />
        </>
      )}
      {pass.kind !== "error" && (
        <Field
          label="How much of the recording to send"
          helperText="Shorter recordings may leave out what led to the problem."
        >
          <NativeSelect.Root size="sm" maxW="xs">
            <NativeSelect.Field
              data-testid="report-bug-keep-minutes"
              value={keepLastMinutes === null ? "all" : String(keepLastMinutes)}
              onChange={(e) => onKeepLastMinutes(e.target.value === "all" ? null : Number(e.target.value))}
            >
              <option value="all">
                {totalMinutes <= 1
                  ? "The whole recording (under a minute)"
                  : `The whole recording (${totalMinutes} min)`}
              </option>
              {Array.from({ length: totalMinutes - 1 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={String(n)}>
                  {n === 1 ? "The last minute" : `The last ${n} minutes`}
                </option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </Field>
      )}
    </Stack>
  );
}

const STAGES = {
  loading: { value: 25, label: "Loading the redaction step" },
  redacting: { value: 60, label: "Redacting the recording" }
};

function RedactionProgress({ stage }: { stage: "loading" | "redacting" }) {
  const { value, label } = STAGES[stage];
  return (
    <Box data-testid="report-bug-replay-loading">
      <Progress.Root value={value} size="sm">
        <Progress.Label fontSize="sm" mb={1}>
          {label}
        </Progress.Label>
        <Progress.Track>
          <Progress.Range />
        </Progress.Track>
      </Progress.Root>
    </Box>
  );
}

function RemainingList({
  id,
  remaining,
  extraRedactions,
  onRedact
}: {
  id: string;
  remaining: RemainingString[];
  extraRedactions: string[];
  onRedact: (value: string) => void;
}) {
  const announce = useAnnouncer();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Index (in the flat list) of the redact button to focus after a redaction. */
  const focusIndex = useRef<number | null>(null);

  // Hide a string as soon as it is picked; the re-run then drops it for real.
  const visible = useMemo(
    () => remaining.filter((r) => !extraRedactions.includes(r.value)),
    [remaining, extraRedactions]
  );
  const groups = useMemo(
    () =>
      KIND_ORDER.map((kind) => ({ kind, items: visible.filter((r) => r.kind === kind) })).filter(
        (g) => g.items.length > 0
      ),
    [visible]
  );

  // Put focus back after the button that had it went away: on the next string's button, or
  // the list heading when none are left. A layout effect, so it runs before the dialog's focus
  // trap notices the removal and sends focus to the description.
  useLayoutEffect(() => {
    const index = focusIndex.current;
    if (index === null) return;
    focusIndex.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && listRef.current?.contains(active)) return;
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-redact]") ?? [];
    const target = buttons[Math.min(index, buttons.length - 1)];
    if (target) target.focus();
    else headingRef.current?.focus();
  }, [visible]);

  const redact = (value: string, index: number) => {
    focusIndex.current = index;
    onRedact(value);
    announce(`Redacted. ${visible.length - 1} ${visible.length - 1 === 1 ? "string remains" : "strings remain"}.`);
  };

  let flatIndex = 0;
  return (
    <Box ref={listRef} data-testid="report-bug-remaining">
      <Heading as="h3" size="sm" ref={headingRef} tabIndex={-1} id={id} mb={1}>
        Text in the recording
      </Heading>
      <Text fontSize="sm" color="fg.muted" mb={2}>
        Everything else is masked. Redact any of these you don&apos;t want to send.
      </Text>
      {groups.length === 0 ? (
        <Text fontSize="sm" data-testid="report-bug-remaining-empty">
          No readable text is left in the recording.
        </Text>
      ) : (
        <Stack gap={3} maxH="16rem" overflowY="auto" pr={1}>
          {groups.map((group) => (
            <Box key={group.kind} as="section" aria-labelledby={`${id}-${group.kind}`} data-kind={group.kind}>
              <Heading as="h4" size="xs" id={`${id}-${group.kind}`} mb={1}>
                {KIND_LABELS[group.kind]} ({group.items.length})
              </Heading>
              <List.Root variant="plain" gap={1}>
                {group.items.map((item) => {
                  const index = flatIndex++;
                  const valueId = `${id}-v${index}`;
                  const buttonId = `${id}-b${index}`;
                  return (
                    <List.Item
                      key={`${item.kind}:${item.value}`}
                      display="flex"
                      alignItems="center"
                      gap={2}
                      data-testid="report-bug-remaining-item"
                    >
                      <Text as="span" id={valueId} flex="1" minW={0} fontSize="sm" wordBreak="break-word" data-value="">
                        {item.value}
                      </Text>
                      {item.count > 1 && (
                        <Text as="span" fontSize="xs" color="fg.muted" flexShrink={0}>
                          {item.count} times
                        </Text>
                      )}
                      <Button
                        size="xs"
                        variant="outline"
                        flexShrink={0}
                        data-redact=""
                        id={buttonId}
                        // Named "Redact <string>" by reference, not with aria-label: Sentry's
                        // click breadcrumbs copy an element's aria-label, and the string must
                        // not leave in one after the user redacted it.
                        aria-labelledby={`${buttonId} ${valueId}`}
                        onClick={() => redact(item.value, index)}
                      >
                        Redact
                      </Button>
                    </List.Item>
                  );
                })}
              </List.Root>
            </Box>
          ))}
        </Stack>
      )}
    </Box>
  );
}
