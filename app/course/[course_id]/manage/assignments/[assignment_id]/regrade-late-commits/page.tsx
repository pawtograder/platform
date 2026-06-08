"use client";

import Link from "@/components/ui/link";
import { toaster, Toaster } from "@/components/ui/toaster";
import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import {
  applyDeadlineRegrade,
  DeadlineRegradeBatch,
  DeadlineRegradeCandidate,
  dismissDeadlineRegradeBatch,
  fetchOpenRegradeBatch,
  fetchRegradeBatchById,
  fetchRegradeCandidates,
  skipDeadlineRegrade,
  stageCandidate
} from "@/lib/deadlineRegrade";
import { createClient } from "@/utils/supabase/client";
import { Badge, Box, Button, Code, Dialog, Heading, HStack, Spinner, Table, Text, VStack } from "@chakra-ui/react";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Busy = Record<number, "staging" | "applying" | "skipping" | undefined>;

function scoreText(s: number | null): string {
  return s === null || s === undefined ? "—" : `${s}`;
}

function DeltaBadge({ current, next }: { current: number | null; next: number | null }) {
  if (current === null || current === undefined || next === null || next === undefined) {
    return <Badge colorPalette="gray">n/a</Badge>;
  }
  const delta = next - current;
  if (delta > 0) return <Badge colorPalette="green">+{delta}</Badge>;
  if (delta < 0) return <Badge colorPalette="red">{delta}</Badge>;
  return <Badge colorPalette="gray">0</Badge>;
}

export default function RegradeLateCommitsPage() {
  const { course_id, assignment_id } = useParams();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createClient(), []);

  const [batch, setBatch] = useState<DeadlineRegradeBatch | null>(null);
  const [candidates, setCandidates] = useState<DeadlineRegradeCandidate[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>({});
  const [confirmLower, setConfirmLower] = useState<DeadlineRegradeCandidate | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const batchParam = searchParams.get("batch");

  const loadNames = useCallback(
    async (rows: DeadlineRegradeCandidate[]) => {
      const profileIds = Array.from(new Set(rows.map((r) => r.profile_id).filter(Boolean))) as string[];
      const groupIds = Array.from(new Set(rows.map((r) => r.assignment_group_id).filter(Boolean))) as number[];
      const map: Record<string, string> = {};
      if (profileIds.length) {
        const { data } = await supabase.from("profiles").select("id, name").in("id", profileIds);
        (data ?? []).forEach((p) => {
          if (p.id) map[`p:${p.id}`] = p.name ?? p.id;
        });
      }
      if (groupIds.length) {
        const { data } = await supabase.from("assignment_groups").select("id, name").in("id", groupIds);
        (data ?? []).forEach((g) => {
          map[`g:${g.id}`] = g.name ?? `Group ${g.id}`;
        });
      }
      setNames(map);
    },
    [supabase]
  );

  const refresh = useCallback(
    async (b: DeadlineRegradeBatch | null) => {
      if (!b) return;
      const rows = await fetchRegradeCandidates(supabase, b.id);
      setCandidates(rows);
      await loadNames(rows);
    },
    [supabase, loadNames]
  );

  // Initial load: resolve the batch (from ?batch= or the latest open batch).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        let b: DeadlineRegradeBatch | null = null;
        if (batchParam) {
          b = await fetchRegradeBatchById(supabase, Number(batchParam));
        } else {
          b = await fetchOpenRegradeBatch(supabase, Number(assignment_id));
        }
        if (cancelled) return;
        setBatch(b);
        await refresh(b);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load regrade batch");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, assignment_id, batchParam, refresh]);

  // Poll while any candidate is still grading.
  useEffect(() => {
    const anyGrading = candidates.some((c) => c.staged_status === "grading");
    if (anyGrading && !pollRef.current) {
      pollRef.current = setInterval(() => {
        void refresh(batch);
      }, 5000);
    } else if (!anyGrading && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [candidates, batch, refresh]);

  const nameFor = useCallback(
    (c: DeadlineRegradeCandidate) =>
      c.assignment_group_id
        ? (names[`g:${c.assignment_group_id}`] ?? `Group ${c.assignment_group_id}`)
        : (names[`p:${c.profile_id}`] ?? c.profile_id ?? "Unknown"),
    [names]
  );

  const setRowBusy = (id: number, state: Busy[number]) => setBusy((prev) => ({ ...prev, [id]: state }));

  const handleStage = useCallback(
    async (c: DeadlineRegradeCandidate) => {
      setRowBusy(c.id, "staging");
      try {
        await stageCandidate(supabase, c);
        toaster.create({
          title: "Grading started",
          description: `Grading ${c.sha.slice(0, 7)} for ${nameFor(c)}`,
          type: "info"
        });
        await refresh(batch);
      } catch (e) {
        toaster.error({ title: "Could not start grading", description: e instanceof Error ? e.message : String(e) });
      } finally {
        setRowBusy(c.id, undefined);
      }
    },
    [supabase, batch, refresh, nameFor]
  );

  const doApply = useCallback(
    async (c: DeadlineRegradeCandidate) => {
      setRowBusy(c.id, "applying");
      try {
        const res = await applyDeadlineRegrade(supabase, c.id);
        toaster.create({
          title: "Promoted",
          description: `${nameFor(c)}: ${scoreText(res.old_score ?? null)} → ${scoreText(res.new_score ?? null)}. The student was notified.`,
          type: "success"
        });
        await refresh(batch);
      } catch (e) {
        toaster.error({ title: "Could not promote", description: e instanceof Error ? e.message : String(e) });
      } finally {
        setRowBusy(c.id, undefined);
      }
    },
    [supabase, batch, refresh, nameFor]
  );

  const handleApply = useCallback(
    async (c: DeadlineRegradeCandidate) => {
      // Lower scores are allowed but require an explicit per-row confirmation.
      const lowers = c.current_score !== null && c.staged_score !== null && c.staged_score < c.current_score;
      if (lowers) {
        setConfirmLower(c);
        return;
      }
      await doApply(c);
    },
    [doApply]
  );

  const handleSkip = useCallback(
    async (c: DeadlineRegradeCandidate) => {
      setRowBusy(c.id, "skipping");
      try {
        await skipDeadlineRegrade(supabase, c.id);
        await refresh(batch);
      } catch (e) {
        toaster.error({ title: "Could not skip", description: e instanceof Error ? e.message : String(e) });
      } finally {
        setRowBusy(c.id, undefined);
      }
    },
    [supabase, batch, refresh]
  );

  const handleStageAll = useCallback(async () => {
    const pending = candidates.filter((c) => c.decision === "pending" && c.staged_status === "none");
    for (const c of pending) {
      // Sequential to avoid hammering the workflow-dispatch API.
      await handleStage(c);
    }
  }, [candidates, handleStage]);

  const handleFinish = useCallback(
    async (status: "dismissed" | "applied") => {
      if (!batch) return;
      try {
        await dismissDeadlineRegradeBatch(supabase, batch.id, status);
        toaster.create({ title: status === "applied" ? "Review completed" : "Dismissed", type: "info" });
        setBatch({ ...batch, status });
      } catch (e) {
        toaster.error({ title: "Could not close batch", description: e instanceof Error ? e.message : String(e) });
      }
    },
    [supabase, batch]
  );

  const submissionsBase = `/course/${course_id}/assignments/${assignment_id}/submissions`;

  if (loading) {
    return (
      <Box p={6}>
        <Spinner /> <Text as="span">Loading late commits…</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box p={6}>
        <Text color="fg.error">{error}</Text>
      </Box>
    );
  }

  if (!batch) {
    return (
      <Box p={6}>
        <Heading size="md" mb={2}>
          Re-grade late commits
        </Heading>
        <Text color="fg.muted">
          There is no open review for this assignment. Extend the deadline in the assignment editor to start one.
        </Text>
      </Box>
    );
  }

  const pendingCount = candidates.filter((c) => c.decision === "pending").length;

  return (
    <VStack align="stretch" gap={4} p={4}>
      <Toaster />
      <Box>
        <Heading size="md">Re-grade late commits after deadline extension</Heading>
        <Text fontSize="sm" color="fg.muted">
          Original deadline <TimeZoneAwareDate date={batch.old_due_date} /> → new deadline{" "}
          <TimeZoneAwareDate date={batch.new_due_date} />. {candidates.length} student
          {candidates.length === 1 ? "" : "s"}/group(s) pushed a commit in this window. Grading a commit creates a
          preview score; nothing changes a real grade until you press <b>Promote</b>.
        </Text>
      </Box>

      <HStack>
        <Button size="sm" variant="subtle" onClick={handleStageAll} disabled={batch.status !== "open"}>
          Grade all ungraded
        </Button>
        <Button
          size="sm"
          variant="outline"
          colorPalette="green"
          onClick={() => handleFinish("applied")}
          disabled={batch.status !== "open"}
        >
          Finish review
        </Button>
        <Button size="sm" variant="ghost" onClick={() => handleFinish("dismissed")} disabled={batch.status !== "open"}>
          Dismiss
        </Button>
        {batch.status !== "open" && <Badge colorPalette="gray">{batch.status}</Badge>}
        <Text fontSize="sm" color="fg.muted">
          {pendingCount} pending
        </Text>
      </HStack>

      <Table.Root size="sm" variant="outline">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Student / Group</Table.ColumnHeader>
            <Table.ColumnHeader>Candidate commit</Table.ColumnHeader>
            <Table.ColumnHeader>Pushed</Table.ColumnHeader>
            <Table.ColumnHeader>Current score</Table.ColumnHeader>
            <Table.ColumnHeader>New score</Table.ColumnHeader>
            <Table.ColumnHeader>Δ</Table.ColumnHeader>
            <Table.ColumnHeader>Actions</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {candidates.map((c) => {
            const rowBusy = busy[c.id];
            const isApplied = c.decision === "applied";
            const isSkipped = c.decision === "skipped";
            const graded = c.staged_status === "graded" && c.staged_submission_id !== null;
            return (
              <Table.Row key={c.id} opacity={isSkipped ? 0.5 : 1}>
                <Table.Cell>{nameFor(c)}</Table.Cell>
                <Table.Cell>
                  <VStack align="start" gap={0}>
                    <Code fontSize="xs">{c.sha.slice(0, 7)}</Code>
                    <Text fontSize="xs" color="fg.muted" lineClamp={1} maxW="260px">
                      {c.commit_message ?? ""}
                    </Text>
                  </VStack>
                </Table.Cell>
                <Table.Cell>{c.commit_date ? <TimeZoneAwareDate date={c.commit_date} /> : "—"}</Table.Cell>
                <Table.Cell>
                  {c.current_submission_id ? (
                    <Link href={`${submissionsBase}/${c.current_submission_id}/files`}>
                      {scoreText(c.current_score)}
                    </Link>
                  ) : (
                    <Text color="fg.muted">no submission</Text>
                  )}
                </Table.Cell>
                <Table.Cell>
                  {c.staged_status === "grading" ? (
                    <HStack gap={1}>
                      <Spinner size="xs" />
                      <Text fontSize="xs" color="fg.muted">
                        grading…
                      </Text>
                    </HStack>
                  ) : graded ? (
                    <Link href={`${submissionsBase}/${c.staged_submission_id}/files`}>{scoreText(c.staged_score)}</Link>
                  ) : (
                    <Text color="fg.muted">—</Text>
                  )}
                </Table.Cell>
                <Table.Cell>
                  {graded ? <DeltaBadge current={c.current_score} next={c.staged_score} /> : null}
                </Table.Cell>
                <Table.Cell>
                  {isApplied ? (
                    <Badge colorPalette="green">promoted</Badge>
                  ) : isSkipped ? (
                    <Badge colorPalette="gray">skipped</Badge>
                  ) : batch.status !== "open" ? (
                    <Text fontSize="xs" color="fg.muted">
                      closed
                    </Text>
                  ) : (
                    <HStack gap={2}>
                      {!graded && (
                        <Button
                          size="xs"
                          variant="subtle"
                          loading={rowBusy === "staging" || c.staged_status === "grading"}
                          onClick={() => handleStage(c)}
                        >
                          Grade
                        </Button>
                      )}
                      {graded && (
                        <Button
                          size="xs"
                          colorPalette="green"
                          loading={rowBusy === "applying"}
                          onClick={() => handleApply(c)}
                        >
                          Promote
                        </Button>
                      )}
                      <Button size="xs" variant="ghost" loading={rowBusy === "skipping"} onClick={() => handleSkip(c)}>
                        Skip
                      </Button>
                    </HStack>
                  )}
                </Table.Cell>
              </Table.Row>
            );
          })}
          {candidates.length === 0 && (
            <Table.Row>
              <Table.Cell colSpan={7}>
                <Text color="fg.muted" p={2}>
                  No students pushed a commit between the old and new deadline.
                </Text>
              </Table.Cell>
            </Table.Row>
          )}
        </Table.Body>
      </Table.Root>

      {/* Lower-score confirmation */}
      <Dialog.Root open={confirmLower !== null} onOpenChange={(d) => !d.open && setConfirmLower(null)}>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Promote a lower score?</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              {confirmLower && (
                <Text>
                  Promoting this commit for <b>{nameFor(confirmLower)}</b> will change their autograder score from{" "}
                  <b>{scoreText(confirmLower.current_score)}</b> down to <b>{scoreText(confirmLower.staged_score)}</b>.
                  The student will be notified. Continue?
                </Text>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" onClick={() => setConfirmLower(null)}>
                Cancel
              </Button>
              <Button
                colorPalette="red"
                onClick={async () => {
                  const c = confirmLower;
                  setConfirmLower(null);
                  if (c) await doApply(c);
                }}
              >
                Promote anyway
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
    </VStack>
  );
}
