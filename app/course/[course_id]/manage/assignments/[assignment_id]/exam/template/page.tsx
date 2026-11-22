"use client";

import { ExamFeatureGate } from "../ExamFeatureGate";

import { toaster } from "@/components/ui/toaster";
import { uploadExamTemplate } from "@/lib/exam/examClient";
import { createClient } from "@/utils/supabase/client";
import { Box, Button, Heading, HStack, Input, Spinner, Text, VStack } from "@chakra-ui/react";
import NextLink from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import RegionEditor from "../RegionEditor";

function ExamTemplatePageContent() {
  const { course_id, assignment_id } = useParams();
  const courseId = Number(course_id);
  const assignmentId = Number(assignment_id);
  const [examId, setExamId] = useState<number | null>(null);
  const [gradingRubricId, setGradingRubricId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  // Replacing a template upserts the SAME exam row, so setExamId() below is a no-op and
  // RegionEditor -- whose load effect keys on examId -- keeps rendering the previous pages,
  // signed URLs and region overlays. A later structure save would then persist coordinates
  // drawn against the old template. Remount the editor on every successful upload instead.
  const [templateRevision, setTemplateRevision] = useState(0);
  // Reported by RegionEditor, for the Next control below (#1271).
  const [unsavedRegions, setUnsavedRegions] = useState(false);
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
      setTemplateRevision((r) => r + 1);
      toaster.success({ title: `Uploaded ${result.pages.length} template page(s)` });
    } catch (e) {
      toaster.error({ title: "Upload failed", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setUploading(false);
    }
  }, [courseId, assignmentId]);

  if (loading) return <Spinner />;

  const base = `/course/${courseId}/manage/assignments/${assignmentId}/exam`;

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
        <RegionEditor
          key={`${examId}-${templateRevision}`}
          examId={examId}
          assignmentId={assignmentId}
          gradingRubricId={gradingRubricId}
          onDirtyChange={setUnsavedRegions}
        />
      ) : (
        <Text color="fg.muted">Upload a template PDF to start labeling regions.</Text>
      )}

      {/* The exam overview numbers these pages 1 and 2, which promises a sequence, and step 1
          had no way to reach step 2: you navigated back out to the overview and clicked through
          (#1271). Not disabled while there are unsaved regions -- blocking the way out of a page
          is worse than the mistake it prevents -- but it does say so, because scanning against
          regions that were never saved is the one way this step quietly produces nothing. */}
      <HStack justify="space-between" pt={2} wrap="wrap" gap={2}>
        <Button asChild size="sm" variant="ghost">
          <NextLink href={base}>&larr; Exam overview</NextLink>
        </Button>
        <HStack gap={3} wrap="wrap">
          {unsavedRegions && (
            <Text fontSize="xs" color="fg.warning">
              You have unsaved region changes. Save structure first, or scanning will use the last saved regions.
            </Text>
          )}
          {/* Not `asChild` with `disabled`: asChild renders the Button AS the anchor, and a
              disabled anchor still navigates. With no template uploaded there is no exam to
              scan against, so render a real button that cannot be followed. */}
          {examId ? (
            <Button asChild size="sm" colorPalette="green">
              <NextLink href={`${base}/scans`}>2. Scan &amp; Match &rarr;</NextLink>
            </Button>
          ) : (
            <Button size="sm" colorPalette="green" disabled>
              2. Scan &amp; Match &rarr;
            </Button>
          )}
        </HStack>
      </HStack>
    </VStack>
  );
}

export default function ExamTemplatePage() {
  return (
    <ExamFeatureGate>
      <ExamTemplatePageContent />
    </ExamFeatureGate>
  );
}
