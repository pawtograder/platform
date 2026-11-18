"use client";

import {
  DialogBody,
  DialogCloseTrigger,
  DialogContent,
  DialogHeader,
  DialogRoot,
  DialogTitle
} from "@/components/ui/dialog";
import { toaster } from "@/components/ui/toaster";
import { namesEquivalent } from "@/lib/exam/nameAgreement";
import { createClient } from "@/utils/supabase/client";
import { createFilter, Select } from "chakra-react-select";
import { Badge, Box, Button, Flex, Heading, HStack, Image, Spinner, Table, Text, VStack } from "@chakra-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Scanned = {
  id: number;
  exam_id: number;
  exam_index: number;
  detected_name: string | null;
  detected_sis_id: string | null;
  matched_profile_id: string | null;
  match_confidence: number | null;
  match_status: string;
  submission_id: number | null;
  finalized_at: string | null;
};
type RosterStudent = { profile_id: string; name: string | null; sortable_name: string | null };
type StudentOption = { value: string; label: string };
// Search the student's name only. react-select's default also searches the option's value, which
// here is the profile UUID, so "ed" would match every student whose id contains "ed".
const filterByName = createFilter<StudentOption>({ stringify: (option) => option.label });

const POLL_MS = 4000;

type Filterable<Q> = { eq(column: string, value: string): Q; is(column: string, value: null): Q };
/**
 * A condition that the column still holds the value the reviewer was shown (null-aware: `eq` never
 * matches null). A decision written with these conditions matches no row if the row changed after
 * it was shown, instead of committing against something the reviewer never saw (#1265, #1270).
 */
function asShown<Q extends Filterable<Q>>(query: Q, column: string, value: string | null): Q {
  return value === null ? query.is(column, null) : query.eq(column, value);
}

export default function MatchReview({
  batchId,
  classId,
  batchStatus,
  onBatchChanged
}: {
  batchId: number;
  classId: number;
  /** The parent's exam_scan_batches.status for this batch; rows reload whenever it changes. */
  batchStatus: string;
  /** Asks the parent to reload the batch, after something here changed its status. */
  onBatchChanged: () => Promise<void> | void;
}) {
  const [rows, setRows] = useState<Scanned[]>([]);
  const [roster, setRoster] = useState<RosterStudent[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // The row (and the student picked on it) waiting for "Confirm anyway" after a name mismatch.
  // What the instructor is acknowledging: this student for this scanned name. A re-detected name or
  // another pick needs a new acknowledgment.
  const [pendingAck, setPendingAck] = useState<{ id: number; profileId: string; detectedName: string | null } | null>(
    null
  );
  const confirmButtons = useRef(new Map<number, HTMLButtonElement>());
  const scanSeq = useRef(0);
  const [scanView, setScanView] = useState<{ examIndex: number; url: string | null; error: string | null } | null>(
    null
  );
  const [rowsError, setRowsError] = useState<string | null>(null);
  // A failed roster load is not an empty roster: say so, and keep retrying until it loads.
  const [rosterError, setRosterError] = useState<string | null>(null);
  // The batch status Create was clicked in, until the page reports a different one. If the
  // page's reload after Create fails or is superseded, batchStatus still says 'review' and Create
  // would be offered again, queueing every row a second time.
  const [queuedFrom, setQueuedFrom] = useState<string | null>(null);
  useEffect(() => {
    setQueuedFrom((q) => (q !== null && q !== batchStatus ? null : q));
  }, [batchStatus]);
  // Latest load wins, and nothing is written after unmount (see scans/page.tsx).
  const loadSeq = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const supabase = createClient();
    const { data: scanned, error } = await supabase
      .from("exam_scanned_submissions")
      .select(
        "id, exam_id, exam_index, detected_name, detected_sis_id, matched_profile_id, match_confidence, match_status, submission_id, finalized_at"
      )
      .eq("batch_id", batchId)
      .order("exam_index");
    if (!mounted.current || seq !== loadSeq.current) return;
    // A failed refresh keeps the last rows instead of emptying the table.
    setRowsError(error ? error.message : null);
    if (error) return;
    setRows((scanned ?? []) as Scanned[]);
    setLoaded(true);
  }, [batchId]);

  // The roster does not change while the page is open, so a successful load is kept and not repeated
  // on every poll. A failed one is retried: by the poll below and by Refresh.
  const rosterSeq = useRef(0);
  const loadRoster = useCallback(async () => {
    const seq = ++rosterSeq.current;
    const { data: students, error } = await createClient()
      .from("user_roles")
      .select("private_profile_id, profiles!user_roles_private_profile_id_fkey(name, sortable_name)")
      .eq("class_id", classId)
      .eq("role", "student");
    if (!mounted.current || seq !== rosterSeq.current) return;
    setRosterError(error ? error.message : null);
    if (error) return;
    setRoster(
      (students ?? [])
        .filter((s) => s.private_profile_id)
        .map((s) => ({
          profile_id: s.private_profile_id as string,
          name: (s.profiles as unknown as { name: string | null } | null)?.name ?? null,
          sortable_name: (s.profiles as unknown as { sortable_name: string | null } | null)?.sortable_name ?? null
        }))
    );
  }, [classId]);
  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  // Reload when the batch changes state, e.g. to completed while submissions were being created.
  useEffect(() => {
    void load();
  }, [load, batchStatus]);

  // While the worker creates submissions, rows change one at a time; follow them. Also keep polling
  // while the last load failed: otherwise a failed reload (e.g. the one when the batch turns
  // completed) would leave stale rows on screen with nothing scheduled to replace them.
  // A tick is skipped while the previous poll is still out: if each request takes longer than
  // POLL_MS, the next one would supersede it before it lands and nothing would ever update.
  const polling = useRef(false);
  const rowsFailed = rowsError !== null;
  const rosterFailed = rosterError !== null;
  useEffect(() => {
    if (batchStatus !== "finalizing" && !rowsFailed && !rosterFailed) return;
    const t = setInterval(() => {
      if (document.visibilityState !== "visible" || polling.current) return;
      polling.current = true;
      void Promise.all([load(), rosterFailed ? loadRoster() : undefined]).finally(() => {
        polling.current = false;
      });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [batchStatus, load, loadRoster, rowsFailed, rosterFailed]);

  const setMatch = useCallback(
    async (id: number, profileId: string | null) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      const supabase = createClient();
      // Only over the match that was on screen: if someone else confirmed or changed this exam since,
      // nothing matches, instead of silently undoing their decision.
      let update = supabase
        .from("exam_scanned_submissions")
        .update({
          matched_profile_id: profileId,
          match_status: profileId ? "suggested" : "unmatched",
          // The worker's confidence was for the student it suggested, not this one (#1265).
          match_confidence: null
        })
        .eq("id", id)
        .eq("match_status", row.match_status);
      update = asShown(update, "matched_profile_id", row.matched_profile_id);
      const { data, error } = await update.select("id");
      if (error) {
        toaster.error({ title: "Update failed", description: error.message });
        return;
      }
      if (!data?.length) toaster.error({ title: "This exam changed while you were choosing. Check it again." });
      setPendingAck((p) => (p?.id === id ? null : p));
      await load();
    },
    [rows, load]
  );

  // One searchable option list for every row, sorted the way the roster is (#1270).
  const studentOptions = useMemo<StudentOption[]>(
    () =>
      roster
        .map((s) => ({ value: s.profile_id, label: s.name ?? s.profile_id, sort: s.sortable_name || s.name || "" }))
        .sort((a, b) => a.sort.localeCompare(b.sort))
        .map(({ value, label }) => ({ value, label })),
    [roster]
  );
  const needStudent = rows.filter((r) => !r.matched_profile_id && r.match_status !== "skipped").length;

  const rosterName = useCallback(
    (profileId: string | null) => roster.find((s) => s.profile_id === profileId)?.name ?? null,
    [roster]
  );

  // Two roster students with the same name: matching the scanned name says nothing about which one.
  const nameIsAmbiguous = useCallback(
    (name: string | null) => roster.filter((s) => namesEquivalent(s.name, name)).length > 1,
    [roster]
  );
  const needsAcknowledgment = useCallback(
    (row: Scanned) => {
      const selected = rosterName(row.matched_profile_id);
      return !namesEquivalent(row.detected_name, selected) || nameIsAmbiguous(selected);
    },
    [rosterName, nameIsAmbiguous]
  );

  // The prompt on screen, for closePrompt to compare against without a stale closure.
  const activePrompt = useRef<number | null>(null);
  useEffect(() => {
    activePrompt.current = pendingAck?.id ?? null;
  }, [pendingAck]);
  const closePrompt = useCallback((id: number) => {
    // Only this row's prompt: a confirm that settles late must not close one opened on another row,
    // nor move focus away from it (the next Enter would then land on this row's Confirm).
    if (activePrompt.current !== id) return;
    setPendingAck((p) => (p?.id === id ? null : p));
    // The prompt replaced the row's buttons; put focus back on Confirm instead of losing it.
    requestAnimationFrame(() => confirmButtons.current.get(id)?.focus());
  }, []);

  const confirm = useCallback(
    async (id: number, acknowledged?: { profileId: string; detectedName: string | null }) => {
      const row = rows.find((r) => r.id === id);
      if (!row?.matched_profile_id) {
        toaster.error({ title: "Pick a student first" });
        return;
      }
      // A different name on the paper than the student picked needs a second, deliberate click (#1265).
      const stillAcknowledged =
        acknowledged?.profileId === row.matched_profile_id && acknowledged.detectedName === row.detected_name;
      if (!stillAcknowledged && needsAcknowledgment(row)) {
        setPendingAck({ id, profileId: row.matched_profile_id, detectedName: row.detected_name });
        return;
      }
      const supabase = createClient();
      // Confirm only what the instructor saw: the student, and the name and SIS id read from the
      // paper, which decided whether the acknowledgment was needed. The worker can rewrite those
      // on an unconfirmed row (a redelivered or late match); if any changed meanwhile, nothing matches.
      let update = supabase
        .from("exam_scanned_submissions")
        .update({ match_status: "confirmed" })
        .eq("id", id)
        .eq("matched_profile_id", row.matched_profile_id);
      update = asShown(update, "detected_name", row.detected_name);
      update = asShown(update, "detected_sis_id", row.detected_sis_id);
      const { data, error } = await update.select("id");
      if (acknowledged) closePrompt(id);
      if (error) {
        toaster.error({ title: "Confirm failed", description: error.message });
        return;
      }
      if (!data?.length) toaster.error({ title: "This exam's match changed. Check it again before confirming." });
      await load();
    },
    [rows, load, needsAcknowledgment, closePrompt]
  );

  const viewScan = useCallback(async (row: Scanned) => {
    // Only the latest click may fill the dialog, and not after it was closed.
    const seq = ++scanSeq.current;
    setScanView({ examIndex: row.exam_index, url: null, error: null });
    const supabase = createClient();
    const [{ data: pages, error: pagesErr }, { data: nameRegion, error: regionErr }] = await Promise.all([
      supabase.from("exam_scan_pages").select("image_path").eq("scanned_submission_id", row.id).order("page_index"),
      supabase
        .from("exam_question_regions")
        .select("page_number")
        .eq("exam_id", row.exam_id)
        .eq("kind", "name")
        .limit(1)
        .maybeSingle()
    ]);
    if (seq !== scanSeq.current) return;
    // The page the name was read from (region page_number indexes the exam's pages in page_index
    // order, as in the worker's identity read); the first page when the template has no name region.
    const page = pages?.[(nameRegion?.page_number ?? 1) - 1] ?? pages?.[0];
    const loadError = pagesErr?.message ?? regionErr?.message ?? (page ? null : "No scanned page found.");
    if (loadError || !page) {
      setScanView({ examIndex: row.exam_index, url: null, error: loadError });
      return;
    }
    const { data: signed, error } = await supabase.storage.from("exam-scans").createSignedUrl(page.image_path, 300);
    if (seq !== scanSeq.current) return;
    setScanView({ examIndex: row.exam_index, url: signed?.signedUrl ?? null, error: error?.message ?? null });
  }, []);

  const skip = useCallback(
    async (id: number) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      const supabase = createClient();
      // Same rule as a pick: skip only the exam as it was shown.
      let update = supabase
        .from("exam_scanned_submissions")
        .update({ match_status: "skipped" })
        .eq("id", id)
        .eq("match_status", row.match_status);
      update = asShown(update, "matched_profile_id", row.matched_profile_id);
      const { data, error } = await update.select("id");
      if (error) {
        toaster.error({ title: "Skip failed", description: error.message });
        return;
      }
      if (!data?.length) toaster.error({ title: "This exam changed before it was skipped. Check it again." });
      await load();
    },
    [rows, load]
  );

  const createSubmissions = useCallback(async () => {
    setBusy(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("enqueue_exam_finalize", { p_batch_id: batchId });
      if (error) throw error;
      toaster.success({ title: `Queued ${data ?? 0} submission(s) for creation` });
      // Only a call that queued work moves the batch to 'finalizing'.
      if ((data ?? 0) > 0) setQueuedFrom(batchStatus);
      // The RPC moved the batch to 'finalizing'. Reload here and in the parent, so the page shows
      // that and starts polling, instead of the review state it had before the click (#1262).
      // Awaited, so Create stays disabled until the parent has seen 'finalizing'; otherwise a
      // second click in that gap queues every row again.
      await load();
      await onBatchChanged();
    } catch (e) {
      toaster.error({ title: "Finalize failed", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [batchId, batchStatus, load, onBatchChanged]);

  // Count rows that are not FINALIZED, not rows without a submission id. finalized_at is the
  // worker's single source of truth for "fully finalized" (set last, after the submission row,
  // the page files and the exam artifact are all written). Keying off submission_id instead hid
  // exactly the rows that need another pass: if finalize created the submission but then
  // exhausted its retries, the row is still confirmed and recoverable by enqueue_exam_finalize,
  // yet it dropped out of this count and left the button disabled with no way to resume.
  const unfinalizedCount = rows.filter((r) => r.match_status === "confirmed" && !r.finalized_at).length;
  const confirmedCount = rows.filter((r) => r.match_status === "confirmed").length;
  // The database refuses match edits once the batch is finalizing or completed
  // (exam_scanned_submission_freeze_match), so the page does not offer them either. An errored batch
  // is shown read-only too (#1270): its finalize messages may still be running, and the way back to
  // editing is Retry processing, which returns it to review.
  const matchesFrozen = batchStatus === "finalizing" || batchStatus === "completed" || batchStatus === "error";

  // An errored batch that never got as far as matching has nothing to review.
  if (batchStatus === "error" && loaded && rows.length === 0) return null;

  return (
    <VStack align="stretch" gap={3}>
      <HStack justify="space-between">
        <Heading size="sm">Review matches ({rows.length} exams)</Heading>
        <Button
          size="sm"
          colorPalette="green"
          onClick={createSubmissions}
          loading={busy}
          disabled={busy || batchStatus === "finalizing" || queuedFrom === batchStatus || unfinalizedCount === 0}
        >
          Create {unfinalizedCount} submission(s)
        </Button>
      </HStack>
      {/* Always mounted, so screen readers announce the first progress text, not only changes. */}
      <HStack role="status" gap={2}>
        {batchStatus === "finalizing" && (
          <>
            <Spinner size="xs" />
            <Text fontSize="sm">
              {loaded
                ? `Creating submissions: ${confirmedCount - unfinalizedCount} of ${confirmedCount}`
                : "Creating submissions…"}
            </Text>
          </>
        )}
      </HStack>
      {rowsError && (
        <Text fontSize="xs" color="fg.error">
          Couldn&apos;t refresh the matches ({rowsError}). What you see may be out of date.
        </Text>
      )}
      {needStudent > 0 && !matchesFrozen && (
        <Text fontSize="sm">
          {needStudent} exam(s) need a student. Pick one in the Student column (type to search), then Confirm. Skip a
          sheet that is not a student&apos;s exam.
        </Text>
      )}
      {rosterError && (
        <Text fontSize="xs" color="fg.error">
          Couldn&apos;t load the student list ({rosterError}). Retrying; until then no student can be picked.
        </Text>
      )}
      <Table.Root size="sm" variant="outline">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Exam</Table.ColumnHeader>
            <Table.ColumnHeader>Detected</Table.ColumnHeader>
            <Table.ColumnHeader>Match</Table.ColumnHeader>
            <Table.ColumnHeader>Student</Table.ColumnHeader>
            <Table.ColumnHeader>Actions</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((r) => (
            <Table.Row key={r.id}>
              <Table.Cell>#{r.exam_index + 1}</Table.Cell>
              <Table.Cell>
                <Text fontSize="xs">{r.detected_name ?? "—"}</Text>
                <Text fontSize="xs" color="fg.muted">
                  SIS: {r.detected_sis_id ?? "—"}
                </Text>
                <Button size="2xs" variant="plain" px={0} onClick={() => viewScan(r)}>
                  View scan
                </Button>
              </Table.Cell>
              <Table.Cell>
                {r.submission_id ? (
                  <Badge colorPalette="blue">created</Badge>
                ) : r.match_status === "confirmed" ? (
                  <Badge colorPalette="green">confirmed</Badge>
                ) : r.match_status === "suggested" ? (
                  <Badge colorPalette="yellow">
                    suggested{r.match_confidence != null ? ` (${Math.round(r.match_confidence * 100)}%)` : ""}
                  </Badge>
                ) : r.match_status === "skipped" ? (
                  <Badge>skipped</Badge>
                ) : (
                  <Badge colorPalette="orange">Needs a student</Badge>
                )}
                {r.matched_profile_id && needsAcknowledgment(r) && (
                  <Text fontSize="xs" color="fg.warning" mt={1}>
                    Scan: {r.detected_name ? `“${r.detected_name}”` : "no name read"} · Selected: “
                    {rosterName(r.matched_profile_id) ?? "unknown"}”
                    {r.match_status === "suggested" && [0.9, 0.5].includes(r.match_confidence ?? -1)
                      ? " · SIS matched"
                      : ""}
                  </Text>
                )}
              </Table.Cell>
              <Table.Cell>
                <Box width="220px">
                  <Select<StudentOption, false>
                    size="sm"
                    aria-label={`Student for exam #${r.exam_index + 1}`}
                    placeholder="Search students…"
                    isClearable
                    isDisabled={!!r.submission_id || matchesFrozen}
                    options={studentOptions}
                    filterOption={filterByName}
                    value={
                      studentOptions.find((o) => o.value === r.matched_profile_id) ??
                      // Matched to someone not (or not yet) in the roster list: say so, don't look empty.
                      (r.matched_profile_id
                        ? { value: r.matched_profile_id, label: "Student not on the roster" }
                        : null)
                    }
                    // Re-choosing the same student would un-confirm the row; ignore it.
                    onChange={(opt) => {
                      if ((opt?.value ?? null) !== r.matched_profile_id) void setMatch(r.id, opt?.value ?? null);
                    }}
                    // The table cell clips the menu; render it on the page instead.
                    menuPortalTarget={typeof document === "undefined" ? undefined : document.body}
                    chakraStyles={{ menuList: (base) => ({ ...base, maxHeight: "240px" }) }}
                    styles={{ menuPortal: (base) => ({ ...base, zIndex: 2000 }) }}
                  />
                </Box>
              </Table.Cell>
              <Table.Cell>
                {pendingAck?.id === r.id ? (
                  // Keyed on what is being acknowledged: when the row changed under an open prompt and it
                  // asks again, it remounts, so focus goes back to Cancel instead of staying on
                  // "Confirm anyway", where one more Enter would accept a name nobody has read.
                  <Box key={`${pendingAck.profileId}|${pendingAck.detectedName ?? ""}`} role="alert" maxW="260px">
                    <Text fontSize="xs" mb={1}>
                      {namesEquivalent(pendingAck.detectedName, rosterName(pendingAck.profileId))
                        ? `More than one student is named “${rosterName(pendingAck.profileId)}”.`
                        : `The scan says ${pendingAck.detectedName ? `“${pendingAck.detectedName}”` : "nothing readable"}, not “${rosterName(pendingAck.profileId) ?? "this student"}”.`}{" "}
                      Check the scan first.
                    </Text>
                    <HStack gap={1}>
                      {/* Cancel comes first, where Confirm was, and has focus: a repeated Enter or the
                          second click of a double-click on Confirm lands on it, not on the warning. */}
                      <Button size="xs" variant="ghost" autoFocus onClick={() => closePrompt(r.id)}>
                        Cancel
                      </Button>
                      <Button
                        size="xs"
                        colorPalette="orange"
                        disabled={!!r.submission_id || matchesFrozen}
                        onClick={() => confirm(r.id, pendingAck)}
                      >
                        Confirm anyway
                      </Button>
                    </HStack>
                  </Box>
                ) : (
                  <HStack gap={1}>
                    <Button
                      size="xs"
                      variant="outline"
                      ref={(el: HTMLButtonElement | null) => {
                        if (el) confirmButtons.current.set(r.id, el);
                        else confirmButtons.current.delete(r.id);
                      }}
                      onClick={() => confirm(r.id)}
                      disabled={!!r.submission_id || matchesFrozen}
                    >
                      Confirm
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => skip(r.id)}
                      disabled={!!r.submission_id || matchesFrozen}
                    >
                      Skip
                    </Button>
                  </HStack>
                )}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      <Flex>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            // The batch too, so its badge and frozen state agree with the rows (#1262 step 5).
            void load();
            void onBatchChanged();
            if (rosterError) void loadRoster();
          }}
        >
          Refresh
        </Button>
      </Flex>
      <DialogRoot
        open={scanView !== null}
        onOpenChange={(d) => {
          if (d.open) return;
          scanSeq.current++; // a response still on its way must not reopen it
          setScanView(null);
        }}
        size="lg"
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Scan of exam #{(scanView?.examIndex ?? 0) + 1}</DialogTitle>
          </DialogHeader>
          <DialogCloseTrigger />
          <DialogBody pb={4}>
            {scanView?.error ? (
              <Text color="fg.error" fontSize="sm">
                Couldn&apos;t load the scan: {scanView.error}
              </Text>
            ) : scanView?.url ? (
              <Image
                src={scanView.url}
                alt={`Scanned page of exam #${scanView.examIndex + 1}`}
                maxW="100%"
                onError={() => setScanView((v) => (v ? { ...v, url: null, error: "The image did not load." } : v))}
              />
            ) : (
              <Spinner />
            )}
          </DialogBody>
        </DialogContent>
      </DialogRoot>
    </VStack>
  );
}
