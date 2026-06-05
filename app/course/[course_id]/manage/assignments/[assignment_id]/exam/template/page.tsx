"use client";

import { toaster } from "@/components/ui/toaster";
import { uploadExamTemplate } from "@/lib/exam/examClient";
import { createClient } from "@/utils/supabase/client";
import { Box, Button, Heading, HStack, Input, Spinner, Text, VStack } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import RegionEditor from "../RegionEditor";

export default function ExamTemplatePage() {
  const { course_id, assignment_id } = useParams();
  const courseId = Number(course_id);
  const assignmentId = Number(assignment_id);
  const [examId, setExamId] = useState<number | null>(null);
  const [gradingRubricId, setGradingRubricId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const [{ data: exam }, { data: assignment }] = await Promise.all([
      supabase.from("exams").select("id").eq("assignment_id", assignmentId).maybeSingle(),
      supabase.from("assignments").select("grading_rubric_id").eq("id", assignmentId).maybeSingle()
    ]);
    setExamId(exam?.id ?? null);
    setGradingRubricId(assignment?.grading_rubric_id ?? null);
    setLoading(false);
  }, [assignmentId]);

  useEffect(() => {
    load();
  }, [load]);

  const onUpload = useCallback(async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      toaster.error({ title: "Choose a PDF first" });
      return;
    }
    setUploading(true);
    try {
      const supabase = createClient();
      const result = await uploadExamTemplate(supabase, courseId, assignmentId, file);
      setExamId(result.examId);
      toaster.success({ title: `Uploaded ${result.pages.length} template page(s)` });
    } catch (e) {
      toaster.error({ title: "Upload failed", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setUploading(false);
    }
  }, [courseId, assignmentId]);

  if (loading) return <Spinner />;

  return (
    <VStack align="stretch" gap={5} pt={2}>
      <Heading size="md">Exam Template &amp; Regions</Heading>
      <Box borderWidth="1px" borderRadius="md" p={3}>
        <Text fontSize="sm" mb={2}>
          Upload the blank exam as a PDF. Each page is rasterized so you can label question regions.
        </Text>
        <HStack>
          <Input ref={fileRef} type="file" accept="application/pdf" size="sm" maxW="360px" />
          <Button size="sm" onClick={onUpload} loading={uploading}>
            {examId ? "Replace template" : "Upload template"}
          </Button>
        </HStack>
      </Box>

      {examId ? (
        <RegionEditor examId={examId} gradingRubricId={gradingRubricId} />
      ) : (
        <Text color="fg.muted">Upload a template PDF to start labeling regions.</Text>
      )}
    </VStack>
  );
}
