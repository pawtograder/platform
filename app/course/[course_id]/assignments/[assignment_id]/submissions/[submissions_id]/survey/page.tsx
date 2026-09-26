"use client";

import SubmissionSurveyPanel from "@/components/survey/SubmissionSurveyPanel";
import { useSubmission } from "@/hooks/useSubmission";

export default function SubmissionSurveyPage() {
  // The submission comes from the layout's provider rather than the route params, so the
  // id is already a number and already the submission the rest of the tabs are showing.
  const submission = useSubmission();
  return <SubmissionSurveyPanel submissionId={submission.id} />;
}
