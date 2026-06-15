"use client";

// Question-first quiz/worksheet builder. The instructor authors questions (and, for
// objective questions, an answer key), then we GENERATE a printable PDF — so every answer
// region is known exactly — and persist the questions + regions. The same definition is
// delivered in-app (quiz) or printed + scanned (paper exam), chosen via delivery mode.

import { toaster } from "@/components/ui/toaster";
import QuestionTreeEditor, { type BuilderQuestion } from "@/components/exam/QuestionTreeEditor";
import { generateAndUploadExamTemplate, type AssessmentQuestion } from "@/lib/exam/examClient";
import { createClient } from "@/utils/supabase/client";
import { Alert, Badge, Box, Button, Heading, HStack, NativeSelect, Spinner, Text, VStack } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type DeliveryMode = "in_app" | "paper";

export default function QuizBuilder() {
  const { course_id, assignment_id } = useParams();
  const courseId = Number(course_id);
  const assignmentId = Number(assignment_id);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [questions, setQuestions] = useState<BuilderQuestion[]>([]);
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("in_app");
  const [gradingRubricId, setGradingRubricId] = useState<number | null>(null);
  const [assignmentTitle, setAssignmentTitle] = useState<string>("");
  const [locked, setLocked] = useState(false);
  const [examId, setExamId] = useState<number | null>(null);
  const [pdfPath, setPdfPath] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data: assignment } = await supabase
      .from("assignments")
      .select("title, grading_rubric_id")
      .eq("id", assignmentId)
      .maybeSingle();
    setAssignmentTitle(assignment?.title ?? "");
    setGradingRubricId(assignment?.grading_rubric_id ?? null);

    const { data: exam } = await supabase
      .from("exams")
      .select("id, delivery_mode, template_pdf_path")
      .eq("assignment_id", assignmentId)
      .maybeSingle();

    if (exam) {
      setExamId(exam.id);
      setDeliveryMode((exam.delivery_mode as DeliveryMode) ?? "in_app");
      setPdfPath(exam.template_pdf_path ?? null);

      // Re-editing after students have submitted would re-create question rows with new
      // ids and orphan their artifact/rubric back-references — lock the builder instead.
      const { count } = await supabase
        .from("submissions")
        .select("id", { count: "exact", head: true })
        .eq("assignment_id", assignmentId);
      setLocked((count ?? 0) > 0);

      const { data: qrows } = await supabase
        .from("exam_questions")
        .select(
          "id, parent_id, level, ordinal, label, prompt, answer_type, choices, points, correct_answer, grading_tolerance"
        )
        .eq("exam_id", exam.id)
        .order("level")
        .order("ordinal");
      const idToClient = new Map<number, string>();
      const loaded: BuilderQuestion[] = (qrows ?? []).map((q) => {
        const client_id = Math.random().toString(36).slice(2, 10);
        idToClient.set(q.id, client_id);
        const rawChoices = q.choices as unknown;
        return {
          id: q.id,
          client_id,
          parent_client_id: null,
          level: (q.level as 1 | 2 | 3) ?? 1,
          ordinal: Number(q.ordinal ?? 0),
          label: q.label ?? "",
          prompt: q.prompt ?? "",
          answer_type: q.answer_type ?? "free_text",
          choices: Array.isArray(rawChoices) ? rawChoices.map((c) => String(c)) : [],
          points: Number(q.points ?? 0),
          correct_answer: (q.correct_answer as unknown) ?? null,
          grading_tolerance: q.grading_tolerance == null ? null : Number(q.grading_tolerance)
        };
      });
      (qrows ?? []).forEach((q, i) => {
        if (q.parent_id != null) loaded[i].parent_client_id = idToClient.get(q.parent_id) ?? null;
      });
      setQuestions(loaded);
    }
    setLoading(false);
  }, [assignmentId]);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async () => {
    if (!questions.length) {
      toaster.error({ title: "Add at least one question" });
      return;
    }
    setSaving(true);
    try {
      const supabase = createClient();
      const payload: AssessmentQuestion[] = questions.map((q) => ({
        id: q.id ?? null,
        client_id: q.client_id,
        parent_client_id: q.parent_client_id,
        level: q.level,
        ordinal: q.ordinal,
        label: q.label,
        prompt: q.prompt,
        answer_type: q.answer_type,
        choices: q.choices,
        points: q.points,
        correct_answer: q.correct_answer,
        grading_tolerance: q.grading_tolerance
      }));
      const result = await generateAndUploadExamTemplate(supabase, courseId, assignmentId, payload, {
        deliveryMode,
        title: assignmentTitle
      });
      setExamId(result.examId);
      setPdfPath(`classes/${courseId}/exams/${result.examId}/template/generated.pdf`);

      // scaffold the grading rubric from the question tree
      if (gradingRubricId) {
        const { error: syncErr } = await supabase.rpc("exam_sync_rubric_from_questions", {
          p_exam_id: result.examId,
          p_rubric_id: gradingRubricId
        });
        if (syncErr) {
          toaster.error({ title: "Rubric sync failed", description: syncErr.message });
        }
      }
      toaster.success({
        title: "Saved",
        description: `Generated ${result.pages.length} page(s) and ${result.regions} region(s).`
      });
    } catch (e) {
      toaster.error({ title: "Save failed", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }, [questions, courseId, assignmentId, deliveryMode, assignmentTitle, gradingRubricId]);

  const downloadPdf = useCallback(async () => {
    if (!pdfPath) return;
    const supabase = createClient();
    const { data, error } = await supabase.storage.from("exam-templates").createSignedUrl(pdfPath, 60 * 10);
    if (error || !data?.signedUrl) {
      toaster.error({ title: "Could not get PDF", description: error?.message });
      return;
    }
    window.open(data.signedUrl, "_blank");
  }, [pdfPath]);

  if (loading) return <Spinner />;

  return (
    <VStack align="stretch" gap={4} pt={2}>
      <HStack justify="space-between">
        <Heading size="md">Quiz / Worksheet Builder</Heading>
        {examId && <Badge colorPalette="green">Saved</Badge>}
      </HStack>

      {locked && (
        <Alert.Root status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Editing is locked</Alert.Title>
            <Alert.Description>
              Students have already submitted, so the question set can&apos;t be changed (it would orphan their saved
              answers). Duplicate the assignment to make changes.
            </Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}

      <HStack gap={3} wrap="wrap">
        <Box>
          <Text fontSize="xs" color="fg.muted" mb={1}>
            Delivery
          </Text>
          <NativeSelect.Root size="sm" width="220px" disabled={locked}>
            <NativeSelect.Field value={deliveryMode} onChange={(e) => setDeliveryMode(e.target.value as DeliveryMode)}>
              <option value="in_app">In-app quiz</option>
              <option value="paper">Printable paper exam</option>
            </NativeSelect.Field>
          </NativeSelect.Root>
        </Box>
        <Box alignSelf="flex-end">
          <Button size="sm" colorPalette="green" onClick={save} loading={saving} disabled={locked}>
            Save &amp; generate
          </Button>
        </Box>
        {pdfPath && (
          <Box alignSelf="flex-end">
            <Button size="sm" variant="outline" onClick={downloadPdf}>
              Download printable PDF
            </Button>
          </Box>
        )}
      </HStack>

      <Text fontSize="sm" color="fg.muted">
        Build your questions below. Objective questions (multiple choice, numeric, true/false) are auto-graded against
        the answer key; free-text answers are graded by rubric. Saving generates a printable PDF whose answer regions
        align to this definition.
      </Text>

      <Box
        borderWidth="1px"
        borderRadius="md"
        p={3}
        opacity={locked ? 0.6 : 1}
        pointerEvents={locked ? "none" : "auto"}
      >
        <QuestionTreeEditor questions={questions} onChange={setQuestions} showAnswerKey />
      </Box>
    </VStack>
  );
}
