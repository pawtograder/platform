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
import {
  Badge,
  Box,
  Button,
  Flex,
  Heading,
  HStack,
  Image,
  NativeSelect,
  Spinner,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import { useCallback, useEffect, useRef, useState } from "react";

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
type RosterStudent = { profile_id: string; name: string | null };

const POLL_MS = 4000;

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

  // The roster does not change while the page is open; load it once, not on every poll.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data: students } = await createClient()
        .from("user_roles")
        .select("private_profile_id, profiles!user_roles_private_profile_id_fkey(name)")
        .eq("class_id", classId)
        .eq("role", "student");
      if (cancelled) return;
      setRoster(
        (students ?? [])
          .filter((s) => s.private_profile_id)
          .map((s) => ({
            profile_id: s.private_profile_id as string,
            name: (s.profiles as unknown as { name: string | null } | null)?.name ?? null
          }))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [classId]);

  // Reload when the batch changes state, e.g. to completed while submissions were being created.
  useEffect(() => {
    void load();
  }, [load, batchStatus]);

  // While the worker creates submissions, rows change one at a time; follow them.
  // A tick is skipped while the previous poll is still out: if each request takes longer than
  // POLL_MS, the next one would supersede it before it lands and nothing would ever update.
  const polling = useRef(false);
  useEffect(() => {
    if (batchStatus !== "finalizing") return;
    const t = setInterval(() => {
      if (document.visibilityState !== "visible" || polling.current) return;
      polling.current = true;
      void load().finally(() => {
        polling.current = false;
      });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [batchStatus, load]);

  const setMatch = useCallback(
    async (id: number, profileId: string | null) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("exam_scanned_submissions")
        .update({
          matched_profile_id: profileId,
          match_status: profileId ? "suggested" : "unmatched",
          // The worker's confidence was for the student it suggested, not this one (#1265).
          match_confidence: null
        })
        .eq("id", id);
      if (error) {
        toaster.error({ title: "Update failed", description: error.message });
        return;
      }
      setPendingAck((p) => (p?.id === id ? null : p));
      await load();
    },
    [load]
  );

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

  const closePrompt = useCallback((id: number) => {
    setPendingAck(null);
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
      // Confirm only the student the instructor saw: if the row changed meanwhile, nothing matches.
      const { data, error } = await supabase
        .from("exam_scanned_submissions")
        .update({ match_status: "confirmed" })
        .eq("id", id)
        .eq("matched_profile_id", row.matched_profile_id)
        .select("id");
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
      const supabase = createClient();
      const { error } = await supabase
        .from("exam_scanned_submissions")
        .update({ match_status: "skipped" })
        .eq("id", id);
      if (error) {
        toaster.error({ title: "Skip failed", description: error.message });
        return;
      }
      await load();
    },
    [load]
  );

  const createSubmissions = useCallback(async () => {
    setBusy(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("enqueue_exam_finalize", { p_batch_id: batchId });
      if (error) throw error;
      toaster.success({ title: `Queued ${data ?? 0} submission(s) for creation` });
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
  }, [batchId, load, onBatchChanged]);

  // Count rows that are not FINALIZED, not rows without a submission id. finalized_at is the
  // worker's single source of truth for "fully finalized" (set last, after the submission row,
  // the page files and the exam artifact are all written). Keying off submission_id instead hid
  // exactly the rows that need another pass: if finalize created the submission but then
  // exhausted its retries, the row is still confirmed and recoverable by enqueue_exam_finalize,
  // yet it dropped out of this count and left the button disabled with no way to resume.
  const unfinalizedCount = rows.filter((r) => r.match_status === "confirmed" && !r.finalized_at).length;
  const confirmedCount = rows.filter((r) => r.match_status === "confirmed").length;
  // The database refuses match edits once the batch is finalizing or completed
  // (exam_scanned_submission_freeze_match), so the page does not offer them either.
  const matchesFrozen = batchStatus === "finalizing" || batchStatus === "completed";

  return (
    <VStack align="stretch" gap={3}>
      <HStack justify="space-between">
        <Heading size="sm">Review matches ({rows.length} exams)</Heading>
        <Button
          size="sm"
          colorPalette="green"
          onClick={createSubmissions}
          loading={busy}
          disabled={busy || batchStatus === "finalizing" || unfinalizedCount === 0}
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
                  <Badge colorPalette="red">unmatched</Badge>
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
                <NativeSelect.Root size="xs" width="200px" disabled={!!r.submission_id || matchesFrozen}>
                  <NativeSelect.Field
                    value={r.matched_profile_id ?? ""}
                    onChange={(e) => setMatch(r.id, e.target.value || null)}
                  >
                    <option value="">— none —</option>
                    {roster.map((s) => (
                      <option key={s.profile_id} value={s.profile_id}>
                        {s.name ?? s.profile_id}
                      </option>
                    ))}
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              </Table.Cell>
              <Table.Cell>
                {pendingAck?.id === r.id ? (
                  <Box role="alert" maxW="260px">
                    <Text fontSize="xs" mb={1}>
                      {namesEquivalent(pendingAck.detectedName, rosterName(pendingAck.profileId))
                        ? `More than one student is named “${rosterName(pendingAck.profileId)}”.`
                        : `The scan says ${pendingAck.detectedName ? `“${pendingAck.detectedName}”` : "nothing readable"}, not “${rosterName(pendingAck.profileId) ?? "this student"}”.`}{" "}
                      Check the scan first.
                    </Text>
                    <HStack gap={1}>
                      <Button
                        size="xs"
                        colorPalette="orange"
                        disabled={!!r.submission_id || matchesFrozen}
                        onClick={() => confirm(r.id, pendingAck)}
                      >
                        Confirm anyway
                      </Button>
                      {/* Focus starts here, so a repeated Enter on Confirm cannot accept the warning. */}
                      <Button size="xs" variant="ghost" autoFocus onClick={() => closePrompt(r.id)}>
                        Cancel
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
