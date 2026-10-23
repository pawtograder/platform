"use client";

/**
 * Live state of an assignment's STAFF repositories (handout and solution).
 *
 * Both are created by github-async-worker after the assignment is inserted, not by the browser, so
 * this is where an instructor finds out whether that worked. One provider in the assignment layout
 * owns a TableController on public.assignment_repo_setup (broadcast to the class staff channel, so
 * it updates as the job runs) and the readiness checklist from get_assignment_repo_setup_checks.
 * The alert shows on every assignment tab; the panel sits on the overview page.
 */
import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { Alert } from "@/components/ui/alert";
import { toaster } from "@/components/ui/toaster";
import { useAssignmentController } from "@/hooks/useAssignment";
import { useIsInstructor } from "@/hooks/useClassProfiles";
import { useCourseController } from "@/hooks/useCourseController";
import TableController, { useTableControllerTableValues } from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { Badge, Box, Button, Heading, HStack, Icon, Link, Text, VStack } from "@chakra-ui/react";
import * as Sentry from "@sentry/nextjs";
import { CheckCircle2, Circle, RefreshCw, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

type SetupRow = Database["public"]["Tables"]["assignment_repo_setup"]["Row"];
type SetupKind = Database["public"]["Enums"]["assignment_repo_kind"];
type SetupState = Database["public"]["Enums"]["assignment_repo_setup_state"];

/** The shape get_assignment_repo_setup_checks returns. */
export type RepoSetupChecks = {
  repo_mode: string;
  has_autograder: boolean;
  release_date: string | null;
  template_repo: string | null;
  latest_template_sha: string | null;
  workflow_sha_set: boolean;
  grader_repo: string | null;
  config_present: boolean;
  graded_parts_count: number;
  latest_autograder_sha: string | null;
  handout_hashes_seeded: boolean;
};

type RepoSetupContextValue = {
  controller: TableController<"assignment_repo_setup"> | undefined;
  rows: Partial<Record<SetupKind, SetupRow>>;
  checks: RepoSetupChecks | null;
};

const RepoSetupContext = createContext<RepoSetupContextValue | null>(null);

const KINDS: SetupKind[] = ["handout", "solution"];
const KIND_LABEL: Record<SetupKind, string> = { handout: "Handout repository", solution: "Solution repository" };
const NO_REPO_MODES = new Set(["none", "no_submission"]);

export function AssignmentRepoSetupProvider({
  assignmentId,
  children
}: {
  assignmentId: number;
  children: React.ReactNode;
}) {
  const { classRealTimeController } = useCourseController();
  const [controller, setController] = useState<TableController<"assignment_repo_setup"> | undefined>(undefined);

  useEffect(() => {
    const client = createClient();
    const tc = new TableController({
      query: client.from("assignment_repo_setup").select("*").eq("assignment_id", assignmentId),
      client,
      table: "assignment_repo_setup",
      classRealTimeController,
      realtimeFilter: { assignment_id: assignmentId },
      // A transition broadcast while the staff channel was disconnected would otherwise be lost
      // until reload; the table is two rows per assignment, so refetching on reconnect is cheap.
      enableAutoRefetch: true
    });
    setController(tc);
    return () => tc.close();
  }, [assignmentId, classRealTimeController]);

  const values = useTableControllerTableValues(controller);
  const rows = useMemo(() => {
    const byKind: Partial<Record<SetupKind, SetupRow>> = {};
    for (const row of values) byKind[row.kind] = row;
    return byKind;
  }, [values]);

  // The checklist reads pointers the jobs write (assignments, autograder, handout hashes), which
  // have no broadcast of their own here. Re-read it whenever a setup row changes, which is
  // exactly when those pointers move.
  const rowsVersion = values.map((r) => `${r.kind}:${r.state}:${r.updated_at}`).join("|");
  const [checks, setChecks] = useState<RepoSetupChecks | null>(null);
  useEffect(() => {
    let cancelled = false;
    const client = createClient();
    client.rpc("get_assignment_repo_setup_checks", { p_assignment_id: assignmentId }).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        // The panel still shows the job state without the checklist; worth knowing, not worth a toast.
        Sentry.captureException(error);
        return;
      }
      setChecks(data as unknown as RepoSetupChecks);
    });
    return () => {
      cancelled = true;
    };
  }, [assignmentId, rowsVersion]);

  const value = useMemo(() => ({ controller, rows, checks }), [controller, rows, checks]);
  return <RepoSetupContext.Provider value={value}>{children}</RepoSetupContext.Provider>;
}

export function useAssignmentRepoSetup(): RepoSetupContextValue {
  const ctx = useContext(RepoSetupContext);
  if (!ctx) throw new Error("useAssignmentRepoSetup must be used inside AssignmentRepoSetupProvider");
  return ctx;
}

/** Whether a missing repository of this kind stops students from working or being graded. */
function kindMatters(kind: SetupKind, hasAutograder: boolean): boolean {
  return kind === "handout" || hasAutograder;
}

function isPending(state: SetupState | undefined): boolean {
  return state === "queued" || state === "in_progress";
}

export function RepoSetupStateBadge({ row }: { row: SetupRow | undefined }) {
  if (!row) return <Badge colorPalette="gray">Unknown</Badge>;
  switch (row.state) {
    case "ready":
      return <Badge colorPalette="green">Ready</Badge>;
    case "skipped":
      // Skipped with a note means a caller opted out at creation (CLI copy --skip-repos); without
      // one, the assignment needs no repository of this kind.
      return <Badge colorPalette="gray">{row.last_error ? "Skipped" : "Not needed"}</Badge>;
    case "in_progress":
      return <Badge colorPalette="blue">Creating…</Badge>;
    case "queued":
      return row.last_error ? <Badge colorPalette="orange">Retrying</Badge> : <Badge colorPalette="blue">Queued</Badge>;
    case "failed":
      return <Badge colorPalette="red">Failed</Badge>;
  }
}

function RetrySetupButton({ assignmentId, kind }: { assignmentId: number; kind: SetupKind }) {
  const { controller } = useAssignmentRepoSetup();
  const [busy, setBusy] = useState(false);
  const retry = useCallback(async () => {
    setBusy(true);
    try {
      const { error } = await createClient().rpc("retry_assignment_repo_setup", {
        p_assignment_id: assignmentId,
        p_kind: kind
      });
      if (error) throw error;
      toaster.success({
        title: "Setup re-queued",
        description: `The ${KIND_LABEL[kind].toLowerCase()} will be created in the background. This page updates on its own.`
      });
      await controller?.refetchAll();
    } catch (e) {
      toaster.error({
        title: "Could not retry",
        description: e instanceof Error ? e.message : "Failed to queue repository setup"
      });
    } finally {
      setBusy(false);
    }
  }, [assignmentId, kind, controller]);
  return (
    <Button size="xs" variant="outline" colorPalette="orange" onClick={retry} loading={busy}>
      <Icon as={RefreshCw} />
      Retry
    </Button>
  );
}

/**
 * Shown above every assignment tab while a repository that students depend on is missing.
 * Escalates with the release date: informational while it is being created ahead of time, a
 * warning within a day of release, and an error once students can see the assignment.
 */
export function AssignmentRepoSetupAlert() {
  const { assignment } = useAssignmentController();
  const { rows } = useAssignmentRepoSetup();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  if (!assignment || NO_REPO_MODES.has(assignment.repo_mode ?? "")) return null;
  const hasAutograder = assignment.has_autograder !== false;
  const blocking = KINDS.filter((k) => {
    const row = rows[k];
    return row && row.state !== "ready" && row.state !== "skipped" && kindMatters(k, hasAutograder);
  });
  if (blocking.length === 0) return null;

  const release = assignment.release_date ? new Date(assignment.release_date).getTime() : null;
  const released = release === null || release <= now;
  const releasingSoon = release !== null && release > now && release - now <= 24 * 60 * 60 * 1000;
  const anyFailed = blocking.some((k) => rows[k]?.state === "failed");
  const allPending = blocking.every((k) => isPending(rows[k]?.state));

  const consequences = blocking.map((k) =>
    k === "handout"
      ? released
        ? "student repositories have not been created"
        : "student repositories cannot be created at release"
      : released
        ? "student submissions cannot be graded"
        : "student submissions will not be graded"
  );
  const what = blocking.map((k) => KIND_LABEL[k].toLowerCase()).join(" and ");
  const status: "error" | "warning" | "info" = released ? "error" : anyFailed || releasingSoon ? "warning" : "info";

  if (status === "info" && allPending) {
    return (
      <Alert status="info" title={`Setting up the ${what}`} mb={2}>
        <Text fontSize="sm">GitHub repositories are being created in the background. This updates on its own.</Text>
      </Alert>
    );
  }

  return (
    <Alert
      status={status}
      title={`The ${what} ${blocking.length > 1 ? "are" : "is"} not ready: ${consequences.join(", and ")}.`}
      mb={2}
    >
      <Text fontSize="sm">
        {anyFailed
          ? "Automatic retries have stopped. See Repository setup on the assignment overview for the error and a Retry button."
          : "Setup is still being retried automatically. See Repository setup on the assignment overview for progress."}
      </Text>
    </Alert>
  );
}

function CheckItem({ ok, label, pending }: { ok: boolean; label: string; pending?: boolean }) {
  return (
    <HStack gap={2}>
      <Icon
        as={ok ? CheckCircle2 : pending ? Circle : XCircle}
        color={ok ? "green.fg" : pending ? "fg.muted" : "red.fg"}
        boxSize={4}
      />
      <Text fontSize="sm" color={ok ? "fg" : "fg.muted"}>
        {label}
      </Text>
    </HStack>
  );
}

function SetupRowView({ assignmentId, kind, canRetry }: { assignmentId: number; kind: SetupKind; canRetry: boolean }) {
  const { rows } = useAssignmentRepoSetup();
  const row = rows[kind];
  return (
    <VStack align="stretch" gap={1} p={3} borderWidth="1px" borderRadius="md">
      <HStack justify="space-between">
        <HStack>
          <Text fontWeight="semibold">{KIND_LABEL[kind]}</Text>
          <RepoSetupStateBadge row={row} />
        </HStack>
        {canRetry && (row?.state === "failed" || (row?.state === "skipped" && !row.repo_full_name)) && (
          <RetrySetupButton assignmentId={assignmentId} kind={kind} />
        )}
      </HStack>
      {row?.repo_full_name && (row.state === "ready" || row.state === "skipped") && (
        <Link href={`https://github.com/${row.repo_full_name}`} target="_blank" fontSize="sm">
          {row.repo_full_name}
        </Link>
      )}
      {row && (row.attempts > 0 || row.failures > 0) && (
        <Text fontSize="xs" color="fg.muted">
          {row.attempts} job{row.attempts === 1 ? "" : "s"} queued · {row.failures} failed attempt
          {row.failures === 1 ? "" : "s"}
          {row.last_attempt_at && (
            <>
              {" · last queued "}
              <TimeZoneAwareDate date={row.last_attempt_at} format="Pp" />
            </>
          )}
          {row.completed_at && row.state === "ready" && (
            <>
              {" · ready "}
              <TimeZoneAwareDate date={row.completed_at} format="Pp" />
            </>
          )}
        </Text>
      )}
      {row?.last_error && row.state === "skipped" && (
        <Text fontSize="sm" color="fg.muted">
          {row.last_error}
        </Text>
      )}
      {row?.last_error && row.state !== "ready" && row.state !== "skipped" && (
        <Text fontSize="sm" color={row.state === "failed" ? "red.fg" : "orange.fg"} whiteSpace="pre-wrap">
          {row.state === "failed" ? "" : "Last attempt failed: "}
          {row.last_error}
        </Text>
      )}
    </VStack>
  );
}

/** Per-repository state, the readiness checklist, and Retry, for the assignment overview. */
export function AssignmentRepoSetupPanel() {
  const { assignment } = useAssignmentController();
  const { checks } = useAssignmentRepoSetup();
  const isInstructor = useIsInstructor();
  if (!assignment || NO_REPO_MODES.has(assignment.repo_mode ?? "")) return null;
  const hasAutograder = assignment.has_autograder !== false;
  const handoutPending = !checks?.template_repo;
  const solutionPending = !checks?.grader_repo;

  return (
    <Box mt={4} mb={4}>
      <Heading size="sm" mb={2}>
        Repository setup
      </Heading>
      <HStack align="stretch" gap={3} flexWrap="wrap">
        <Box flex="1" minW="280px">
          <SetupRowView assignmentId={assignment.id} kind="handout" canRetry={isInstructor} />
        </Box>
        <Box flex="1" minW="280px">
          <SetupRowView assignmentId={assignment.id} kind="solution" canRetry={isInstructor} />
        </Box>
      </HStack>
      {checks && (
        <VStack align="flex-start" gap={1} mt={3}>
          <Text fontSize="sm" fontWeight="semibold">
            Ready for students
          </Text>
          <CheckItem ok={!!checks.template_repo} label="Handout repository recorded" />
          <CheckItem
            ok={!!checks.latest_template_sha}
            pending={handoutPending}
            label="Handout revision recorded (what student repositories are created from)"
          />
          {hasAutograder && (
            <>
              <CheckItem
                ok={checks.workflow_sha_set}
                pending={handoutPending}
                label="Grading workflow hash recorded (submissions are checked against it)"
              />
              <CheckItem ok={!!checks.grader_repo} label="Solution repository recorded" />
              <CheckItem
                ok={checks.config_present}
                pending={solutionPending}
                label={
                  checks.config_present
                    ? `pawtograder.yml read (${checks.graded_parts_count} graded part${checks.graded_parts_count === 1 ? "" : "s"})`
                    : "pawtograder.yml read from the solution repository"
                }
              />
              <CheckItem
                ok={!!checks.latest_autograder_sha}
                pending={solutionPending}
                label="Grader revision recorded"
              />
              <CheckItem
                ok={checks.handout_hashes_seeded}
                pending={handoutPending || solutionPending}
                label="Starter-code fingerprints recorded (unchanged starter code is recognised as an empty submission)"
              />
            </>
          )}
          {hasAutograder && checks.config_present && checks.graded_parts_count === 0 && (
            <Text fontSize="sm" color="orange.fg">
              The solution repository&apos;s pawtograder.yml has no graded parts yet. Push the grader to{" "}
              {checks.grader_repo} before students submit.
            </Text>
          )}
        </VStack>
      )}
    </Box>
  );
}
