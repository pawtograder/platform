"use client";

// Student-facing in-app quiz. Fetches the answer-key-free question tree via the
// quiz_get_for_student RPC, renders it with the shared SurveyJS component, and on submit
// maps answers back to exam_question_ids and calls quiz_submit (which auto-grades).

import SurveyComponent from "@/components/Survey";
import { toaster } from "@/components/ui/toaster";
import { examQuestionIdFromField, examTreeToSurveyJson, type StudentQuizQuestion } from "@/lib/exam/examToSurveyJs";
import { createClient } from "@/utils/supabase/client";
import type { Json } from "@/utils/supabase/SupabaseTypes";
import { Alert, Box, Heading, Spinner, Text, VStack } from "@chakra-ui/react";
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

  const onComplete = useCallback(
    (survey: Model) => {
      const supabase = createClient();
      const data = survey.data as Record<string, unknown>;
      const answers = Object.entries(data)
        .map(([name, value]) => {
          const qid = examQuestionIdFromField(name);
          return qid == null ? null : { exam_question_id: qid, value };
        })
        .filter((a): a is { exam_question_id: number; value: unknown } => a != null);

      (async () => {
        const { error: submitErr } = await supabase.rpc("quiz_submit", {
          p_assignment_id: assignmentId,
          p_answers: answers as unknown as never
        });
        if (submitErr) {
          toaster.error({ title: "Submit failed", description: submitErr.message });
          return;
        }
        toaster.success({ title: "Quiz submitted" });
        router.push(`/course/${courseId}/assignments/${assignmentId}`);
      })();
    },
    [assignmentId, courseId, router]
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
