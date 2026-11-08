"use client";

// Student-facing in-app quiz. Fetches the answer-key-free question tree via the
// quiz_get_for_student RPC, renders it with the shared SurveyJS component, and on submit
// maps answers back to exam_question_ids and calls quiz_submit (which auto-grades).

import SurveyComponent from "@/components/Survey";
import { toaster } from "@/components/ui/toaster";
import { examQuestionIdFromField, examTreeToSurveyJson, type StudentQuizQuestion } from "@/lib/exam/examToSurveyJs";
import { createClient } from "@/utils/supabase/client";
import type { Json } from "@/utils/supabase/SupabaseTypes";
import { Alert, Box, Button, Heading, Spinner, Text, VStack } from "@chakra-ui/react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { Model } from "survey-core";

export default function StudentQuizPage() {
  const { course_id, assignment_id } = useParams();
  const courseId = Number(course_id);
  const assignmentId = Number(assignment_id);
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [surveyJson, setSurveyJson] = useState<Record<string, unknown> | null>(null);
  const [alreadySubmitted, setAlreadySubmitted] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      try {
        // Already submitted? (RLS scopes this to the caller's own submissions.)
        const { data: existing } = await supabase
          .from("submissions")
          .select("id")
          .eq("assignment_id", assignmentId)
          .eq("sha", "quiz")
          .eq("is_active", true)
          .limit(1);
        if (existing && existing.length > 0) {
          setAlreadySubmitted(true);
          setLoading(false);
          return;
        }

        const { data, error: rpcErr } = await supabase.rpc("quiz_get_for_student", {
          p_assignment_id: assignmentId
        });
        if (rpcErr) throw rpcErr;
        const payload = data as { exam_id: number; questions: StudentQuizQuestion[] } | null;
        if (!payload?.questions?.length) {
          setError("This quiz has no questions yet.");
        } else {
          setSurveyJson(examTreeToSurveyJson(payload.questions));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [assignmentId]);

  type QuizAnswer = { exam_question_id: number; value: unknown };
  // SurveyJS has already switched to its completion page by the time onComplete fires, and the
  // answers exist only in in-memory survey state. A failed quiz_submit used to leave nothing but
  // a toast: no retry control, and a reload discarded the attempt entirely, so one transient
  // network error cost the student a whole quiz. Hold the mapped answers so the submit can be
  // retried from the same page.
  const [pendingAnswers, setPendingAnswers] = useState<QuizAnswer[] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submitAnswers = useCallback(
    async (answers: QuizAnswer[]) => {
      setSubmitting(true);
      try {
        const supabase = createClient();
        const { error: submitErr } = await supabase.rpc("quiz_submit", {
          p_assignment_id: assignmentId,
          p_answers: answers as unknown as never
        });
        if (submitErr) {
          setPendingAnswers(answers);
          toaster.error({ title: "Submit failed", description: submitErr.message });
          return;
        }
        setPendingAnswers(null);
        toaster.success({ title: "Quiz submitted" });
        router.push(`/course/${courseId}/assignments/${assignmentId}`);
      } catch (e) {
        setPendingAnswers(answers);
        toaster.error({ title: "Submit failed", description: e instanceof Error ? e.message : String(e) });
      } finally {
        setSubmitting(false);
      }
    },
    [assignmentId, courseId, router]
  );

  const onComplete = useCallback(
    (survey: Model) => {
      const data = survey.data as Record<string, unknown>;
      const answers = Object.entries(data)
        .map(([name, value]) => {
          const qid = examQuestionIdFromField(name);
          return qid == null ? null : { exam_question_id: qid, value };
        })
        .filter((a): a is QuizAnswer => a != null);
      void submitAnswers(answers);
    },
    [submitAnswers]
  );

  if (loading) return <Spinner />;

  return (
    <VStack align="stretch" gap={4} pt={2}>
      <Heading size="md">Quiz</Heading>
      {alreadySubmitted ? (
        <Alert.Root status="success">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Already submitted</Alert.Title>
            <Alert.Description>
              Your quiz has been submitted. Scores appear once your instructor releases them.
            </Alert.Description>
          </Alert.Content>
        </Alert.Root>
      ) : error ? (
        <Alert.Root status="error">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Cannot load quiz</Alert.Title>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      ) : pendingAnswers ? (
        <Alert.Root status="error" flexDirection="column" alignItems="flex-start">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Your quiz was not submitted</Alert.Title>
            <Alert.Description>
              Your {pendingAnswers.length} answer{pendingAnswers.length === 1 ? "" : "s"} are still held on this page.
              Please retry — do not close or reload this tab, or they will be lost.
            </Alert.Description>
            <Button
              mt={3}
              size="sm"
              colorPalette="green"
              loading={submitting}
              onClick={() => void submitAnswers(pendingAnswers)}
            >
              Retry submit
            </Button>
          </Alert.Content>
        </Alert.Root>
      ) : surveyJson ? (
        <Box>
          <Text fontSize="sm" color="fg.muted" mb={3}>
            Answer all questions and submit. Objective questions are graded automatically.
          </Text>
          <SurveyComponent surveyJson={surveyJson as unknown as Json} onComplete={onComplete} />
        </Box>
      ) : null}
    </VStack>
  );
}
