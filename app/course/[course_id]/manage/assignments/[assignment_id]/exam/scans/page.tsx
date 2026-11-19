"use client";

import { ExamFeatureGate } from "../ExamFeatureGate";

import { toaster } from "@/components/ui/toaster";
import { uploadExamScanBatch } from "@/lib/exam/examClient";
import { scanBatchStatus } from "@/lib/exam/scanBatchStatus";
import { createClient } from "@/utils/supabase/client";
import { Badge, Box, Button, Heading, HStack, Input, Spinner, Text, VStack } from "@chakra-ui/react";
import NextLink from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MatchReview from "../MatchReview";
import { getUserFacingErrorMessage } from "@/lib/studentFacingErrorMessages";
import { useStaffErrorRole } from "@/hooks/useStaffErrorRole";

type Batch = { id: number; status: string; total_pages: number; pages_per_exam: number; error: string | null };

const POLL_MS = 4000;

function ExamScansPageContent() {
  const errorRole = useStaffErrorRole();
  const { course_id, assignment_id } = useParams();
  const courseId = Number(course_id);
  const assignmentId = Number(assignment_id);
  const [examId, setExamId] = useState<number | null>(null);
  const [numPages, setNumPages] = useState<number>(1);
  const [pagesPerExam, setPagesPerExam] = useState<number>(1);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  // Pages with OCR done, per batch that is reading pages.
  const [pagesRead, setPagesRead] = useState<Record<number, number>>({});
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<number | null>(null);
  const processingRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Only the latest load may write state: a slow poll response must not overwrite a newer one,
  // and nothing may write after the page unmounts.
  const loadSeq = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadBatches = useCallback(async (exam: number) => {
    const seq = ++loadSeq.current;
    const supabase = createClient();
    const { data, error } = await supabase
      .from("exam_scan_batches")
      .select("id, status, total_pages, pages_per_exam, error")
      .eq("exam_id", exam)
      .order("id", { ascending: false });
    if (!mounted.current || seq !== loadSeq.current) return;
    if (error) {
      // Keep the last list on screen; say that it may be stale instead of toasting every poll.
      setRefreshError(error.message);
      return;
    }
    const loaded = (data ?? []) as Batch[];
    // Same check the match step waits on (exam-async-worker doMatch): a page is read once ocr_data is set.
    const counts = await Promise.all(
      loaded
        .filter((b) => b.status === "ocr")
        .map(async (b) => {
          const { count, error: countError } = await supabase
            .from("exam_scan_pages")
            .select("id", { count: "exact", head: true })
            .eq("batch_id", b.id)
            .not("ocr_data", "is", null);
          return { id: b.id, count, countError };
        })
    );
    if (!mounted.current || seq !== loadSeq.current) return;
    const failedCount = counts.find((c) => c.countError)?.countError;
    setRefreshError(failedCount ? failedCount.message : null);
    setBatches(loaded);
    // A count that failed keeps its last value rather than showing a made-up 0.
    setPagesRead((previous) =>
      Object.fromEntries(counts.map((c) => [c.id, c.countError ? (previous[c.id] ?? 0) : (c.count ?? 0)]))
    );
  }, []);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data: exam, error } = await supabase
      .from("exams")
      .select("id, num_pages")
      .eq("assignment_id", assignmentId)
      .maybeSingle();
    if (error) {
      toaster.error({ title: "Failed to load exam", description: error.message });
      setLoading(false);
      return;
    }
    if (exam) {
      setExamId(exam.id);
      setNumPages(exam.num_pages || 1);
      setPagesPerExam(exam.num_pages || 1);
      await loadBatches(exam.id);
    }
    setLoading(false);
  }, [assignmentId, loadBatches]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while the worker is moving a batch on by itself. A hidden tab skips its ticks and catches
  // up as soon as it is shown again.
  // A tick is skipped while the previous poll is still out: if each request takes longer than
  // POLL_MS, the next one would supersede it before it lands and nothing would ever update.
  const working = useMemo(() => batches.some((b) => scanBatchStatus(b.status).working), [batches]);
  const polling = useRef(false);
  useEffect(() => {
    if (!examId || !working) return;
    const refreshIfVisible = () => {
      if (document.visibilityState !== "visible" || polling.current) return;
      polling.current = true;
      void loadBatches(examId).finally(() => {
        polling.current = false;
      });
    };
    const t = setInterval(refreshIfVisible, POLL_MS);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [examId, working, loadBatches]);

  const onUpload = useCallback(async () => {
    if (!examId) return;
    const file = fileRef.current?.files?.[0];
    if (!file) {
      toaster.error({ title: "Choose a scanned PDF first" });
      return;
    }
    setUploading(true);
    try {
      const supabase = createClient();
      const { batchId, totalPages } = await uploadExamScanBatch(supabase, courseId, examId, file, pagesPerExam);
      toaster.success({ title: `Uploaded ${totalPages} page(s) as batch #${batchId}` });
      await loadBatches(examId);
    } catch (e) {
      toaster.error({ title: "Upload failed", description: getUserFacingErrorMessage(e, { role: errorRole }) });
    } finally {
      setUploading(false);
    }
  }, [examId, courseId, pagesPerExam, loadBatches, errorRole]);

  const process = useCallback(
    async (batchId: number) => {
      // The ref, not the state, stops a double click: both clicks run before a re-render.
      if (processingRef.current) return;
      processingRef.current = true;
      setProcessingId(batchId);
      try {
        const supabase = createClient();
        const { error } = await supabase.rpc("enqueue_exam_process_batch", { p_batch_id: batchId });
        if (error) toaster.error({ title: "Process failed", description: error.message });
        else {
          toaster.success({ title: "Processing started" });
          if (examId) await loadBatches(examId);
        }
      } finally {
        processingRef.current = false;
        setProcessingId(null);
      }
    },
    [examId, loadBatches]
  );

  if (loading) return <Spinner />;
  if (!examId) {
    return (
      <VStack align="start" gap={3} pt={2}>
        <Text color="fg.muted">No exam template yet. Upload one before scanning student exams.</Text>
        <Button asChild colorPalette="green" size="sm">
          <NextLink href={`/course/${courseId}/manage/assignments/${assignmentId}/exam/template`}>
            Go to Template &amp; Regions
          </NextLink>
        </Button>
      </VStack>
    );
  }

  return (
    <VStack align="stretch" gap={5} pt={2}>
      <Heading size="md">Scan &amp; Match</Heading>
      <Box borderWidth="1px" borderRadius="md" p={3}>
        <Text fontSize="sm" mb={2}>
          Upload a single PDF containing all scanned student exams. Pages are split into exams of N pages (template has{" "}
          {numPages} page(s)).
        </Text>
        <HStack>
          <Input ref={fileRef} type="file" accept="application/pdf" size="sm" maxW="320px" />
          <HStack>
            <Text fontSize="xs">Pages/exam</Text>
            <Input
              size="sm"
              type="number"
              width="70px"
              value={pagesPerExam}
              onChange={(e) => setPagesPerExam(Math.max(1, Number(e.target.value)))}
            />
          </HStack>
          <Button size="sm" onClick={onUpload} loading={uploading}>
            Upload scans
          </Button>
        </HStack>
      </Box>

      <VStack align="stretch" gap={4}>
        {refreshError && (
          <Text fontSize="xs" color="fg.error">
            Couldn&apos;t refresh the batches ({refreshError}). What you see may be out of date.
          </Text>
        )}
        {batches.map((b) => {
          const status = scanBatchStatus(b.status);
          return (
            <Box key={b.id} borderWidth="1px" borderRadius="md" p={3}>
              <HStack justify="space-between" mb={2}>
                <HStack>
                  <Heading size="sm">Batch #{b.id}</Heading>
                  <Badge colorPalette={status.colorPalette}>{status.label}</Badge>
                  <Text fontSize="xs" color="fg.muted">
                    {b.total_pages} pages · {b.pages_per_exam}/exam
                  </Text>
                </HStack>
                {(b.status === "uploaded" || b.status === "error") && (
                  <Button
                    size="xs"
                    onClick={() => process(b.id)}
                    loading={processingId === b.id}
                    disabled={processingId !== null}
                  >
                    Process (OCR + match)
                  </Button>
                )}
              </HStack>
              {/* Always mounted, so screen readers announce the first progress text, not only changes. */}
              <HStack role="status" gap={2}>
                {(b.status === "ocr" || b.status === "matching") && (
                  <>
                    <Spinner size="xs" />
                    <Text fontSize="sm" mb={2}>
                      {b.status === "ocr"
                        ? `Reading pages: ${pagesRead[b.id] ?? 0} of ${b.total_pages}`
                        : "Matching names to the roster…"}
                    </Text>
                  </>
                )}
              </HStack>
              {b.error && (
                <Text fontSize="xs" color="fg.error">
                  {b.error}
                </Text>
              )}
              {["review", "finalizing", "completed"].includes(b.status) && (
                <MatchReview
                  batchId={b.id}
                  classId={courseId}
                  batchStatus={b.status}
                  onBatchChanged={() => loadBatches(examId)}
                />
              )}
            </Box>
          );
        })}
        {batches.length === 0 && !refreshError && <Text color="fg.muted">No scan batches yet.</Text>}
      </VStack>
    </VStack>
  );
}

export default function ExamScansPage() {
  return (
    <ExamFeatureGate>
      <ExamScansPageContent />
    </ExamFeatureGate>
  );
}
