"use client";

import { toaster } from "@/components/ui/toaster";
import { uploadExamScanBatch } from "@/lib/exam/examClient";
import { createClient } from "@/utils/supabase/client";
import { Badge, Box, Button, Heading, HStack, Input, Spinner, Text, VStack } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import MatchReview from "../MatchReview";

type Batch = { id: number; status: string; total_pages: number; pages_per_exam: number; error: string | null };

export default function ExamScansPage() {
  const { course_id, assignment_id } = useParams();
  const courseId = Number(course_id);
  const assignmentId = Number(assignment_id);
  const [examId, setExamId] = useState<number | null>(null);
  const [numPages, setNumPages] = useState<number>(1);
  const [pagesPerExam, setPagesPerExam] = useState<number>(1);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadBatches = useCallback(async (exam: number) => {
    const supabase = createClient();
    const { data } = await supabase
      .from("exam_scan_batches")
      .select("id, status, total_pages, pages_per_exam, error")
      .eq("exam_id", exam)
      .order("id", { ascending: false });
    setBatches((data ?? []) as Batch[]);
  }, []);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data: exam } = await supabase
      .from("exams")
      .select("id, num_pages")
      .eq("assignment_id", assignmentId)
      .maybeSingle();
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

  // poll while any batch is mid-processing
  useEffect(() => {
    if (!examId) return;
    const active = batches.some((b) => ["ocr", "matching", "finalizing"].includes(b.status));
    if (!active) return;
    const t = setInterval(() => loadBatches(examId), 4000);
    return () => clearInterval(t);
  }, [examId, batches, loadBatches]);

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
      toaster.error({ title: "Upload failed", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setUploading(false);
    }
  }, [examId, courseId, pagesPerExam, loadBatches]);

  const process = useCallback(
    async (batchId: number) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("enqueue_exam_process_batch", { p_batch_id: batchId });
      if (error) toaster.error({ title: "Process failed", description: error.message });
      else {
        toaster.success({ title: "Processing started" });
        if (examId) await loadBatches(examId);
      }
    },
    [examId, loadBatches]
  );

  if (loading) return <Spinner />;
  if (!examId) {
    return (
      <Text color="fg.muted" pt={2}>
        No exam template yet — configure the template first.
      </Text>
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
        {batches.map((b) => (
          <Box key={b.id} borderWidth="1px" borderRadius="md" p={3}>
            <HStack justify="space-between" mb={2}>
              <HStack>
                <Heading size="sm">Batch #{b.id}</Heading>
                <Badge>{b.status}</Badge>
                <Text fontSize="xs" color="fg.muted">
                  {b.total_pages} pages · {b.pages_per_exam}/exam
                </Text>
              </HStack>
              {(b.status === "uploaded" || b.status === "error") && (
                <Button size="xs" onClick={() => process(b.id)}>
                  Process (OCR + match)
                </Button>
              )}
            </HStack>
            {b.error && (
              <Text fontSize="xs" color="fg.error">
                {b.error}
              </Text>
            )}
            {["review", "finalizing", "completed"].includes(b.status) && (
              <MatchReview batchId={b.id} classId={courseId} />
            )}
          </Box>
        ))}
        {batches.length === 0 && <Text color="fg.muted">No scan batches yet.</Text>}
      </VStack>
    </VStack>
  );
}
