"use client";

import { Box, Heading, Text, VStack, Button, HStack } from "@chakra-ui/react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useRef } from "react";
import { toaster } from "@/components/ui/toaster";
import { getStudentFacingErrorMessage } from "@/lib/studentFacingErrorMessages";
import dynamic from "next/dynamic";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { SurveyResponse, ResponseData } from "@/types/survey";
import { Model, ValueChangedEvent } from "survey-core";
import { useCourseController, useSurvey } from "@/hooks/useCourseController";
import { useIsTableControllerReady } from "@/lib/TableController";
import {
  isSurveyResponseReadOnly,
  resolveResponseWriteFlags,
  responseStateFromLoad,
  shouldAutosaveResponse,
  type LoadedResponseState
} from "@/lib/surveyResponseState";
import {
  runWithTimeout,
  SurveyAutosaveQueue,
  type AutosaveStatus,
  type RetryPolicy,
  type SaveAttempt
} from "@/lib/surveyAutosaveQueue";
import { upsertSurveyResponseWithKeepalive, type SurveyResponseUpsert } from "@/lib/surveyResponseKeepalive";

const AUTOSAVE_DEBOUNCE_MS = 1000;
// Upper bound on one write, autosave or Complete. A survey upsert normally takes well under a
// second; past this the request is cancelled, so it cannot hold up the saves queued behind it.
const SAVE_TIMEOUT_MS = 10_000;
// A failed autosave is retried after 1, 2, 4 and 8 s, then waits for the next edit or for the
// browser to come back online.
const AUTOSAVE_RETRY: RetryPolicy = { baseDelayMs: 1000, maxDelayMs: 8000, maxRetries: 4 };

const AUTOSAVE_STATUS_TEXT: Record<AutosaveStatus, string> = {
  idle: "",
  saving: "Saving…",
  saved: "All changes saved",
  retrying: "Not saved yet. Retrying…",
  offline: "You're offline. Your answers will save when you reconnect.",
  failed: "Your latest answers aren't saved."
};
const AUTOSAVE_STATUS_COLOR: Record<AutosaveStatus, string> = {
  idle: "fg.muted",
  saving: "fg.muted",
  saved: "fg.muted",
  retrying: "fg.warning",
  offline: "fg.warning",
  failed: "fg.error"
};
// The project the browser Supabase client talks to (utils/supabase/client.ts), for the keepalive
// write sent while the page unloads.
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const SurveyComponent = dynamic(() => import("@/components/Survey"), {
  ssr: false,
  loading: () => (
    <Box display="flex" alignItems="center" justifyContent="center" p={8}>
      <Text>Loading survey...</Text>
    </Box>
  )
});

export default function SurveyTakingPage() {
  const { course_id, survey_id } = useParams();
  const router = useRouter();
  const controller = useCourseController();

  // pulls from ClassProfileProvider
  const { private_profile_id, isReadOnly: isViewingAsStudent } = useClassProfiles();

  // Use the survey hook to get the survey with realtime updates
  const survey = useSurvey(survey_id as string);
  const surveysReady = useIsTableControllerReady(controller.surveys);

  const [existingResponse, setExistingResponse] = useState<SurveyResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [autosaveStatus, setAutosaveStatus] = useState<AutosaveStatus>("idle");

  // Autosave/submit coordination. SurveyJS fires a final onValueChanged on blur
  // that can race the Complete upsert: an autosave carrying is_submitted:false
  // that lands after the submit upsert silently reverts the submission. The
  // refs (not state) are needed because the guards must be visible synchronously
  // inside the SurveyJS event callbacks.
  const isSubmittingRef = useRef(false);
  // State of the response row as it exists on the server. Hydrated from the loaded row (not
  // just set by a submit made in this session), because without that a reload of an
  // already-submitted response leaves autosave thinking it is editing a draft, and the first
  // keystroke writes is_submitted:false over the submission.
  const responseStateRef = useRef<LoadedResponseState>("unknown");
  // Which (survey, profile) pair responseStateRef describes, so a re-run of the loader effect
  // for the same response cannot silently discard what it learned.
  const responseStateKeyRef = useRef<string | null>(null);
  // Holds the newest unsaved answers and writes them one at a time, so a slow older write can never
  // land after a newer one. Complete pauses it and waits for the write in flight.
  const autosaveQueueRef = useRef<SurveyAutosaveQueue<ResponseData> | null>(null);
  // The queue outlives renders, so it reads the current save function and guards through refs.
  const saveDraftRef = useRef<(responseData: ResponseData, attempt: SaveAttempt) => Promise<void>>(async () => {});
  const canAutosaveRef = useRef<() => boolean>(() => false);
  // The student's access token, kept current so the write sent while the page unloads does not have
  // to wait for the Supabase client to read it.
  const accessTokenRef = useRef<string | null>(null);

  useEffect(() => {
    const queue = new SurveyAutosaveQueue<ResponseData>({
      save: (responseData, attempt) => saveDraftRef.current(responseData, attempt),
      canSave: () => canAutosaveRef.current(),
      debounceMs: AUTOSAVE_DEBOUNCE_MS,
      timeoutMs: SAVE_TIMEOUT_MS,
      retry: AUTOSAVE_RETRY,
      isOnline: () => navigator.onLine,
      onStatusChange: setAutosaveStatus,
      onError: (error) => {
        console.error("Error auto-saving response:", error);
      }
    });
    autosaveQueueRef.current = queue;

    const retryOnReconnect = () => queue.retryNow();
    const noteOffline = () => queue.noteOffline();
    window.addEventListener("online", retryOnReconnect);
    window.addEventListener("offline", noteOffline);

    // `textUpdateMode = "onTyping"` restarts the debounce on every keystroke, so a student who
    // leaves while typing has an unwritten answer waiting for it. A reload or a closed tab does not
    // unmount React, so the page also flushes when it is hidden (tab switch, app switch on a phone,
    // which may be the last chance) and on pagehide (reload, close, navigation).
    const flushOnLeave = () => queue.flush({ keepalive: true });
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushOnLeave();
    };
    window.addEventListener("pagehide", flushOnLeave);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flushOnLeave);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("online", retryOnReconnect);
      window.removeEventListener("offline", noteOffline);
      // Flush rather than merely cancel when the student navigates away inside the app. That
      // write still goes out, but nothing is retried once the page is gone.
      queue.flush();
      queue.dispose();
      if (autosaveQueueRef.current === queue) autosaveQueueRef.current = null;
    };
  }, []);

  useEffect(() => {
    const {
      data: { subscription }
    } = controller.client.auth.onAuthStateChange((_event, session) => {
      accessTokenRef.current = session?.access_token ?? null;
    });
    return () => subscription.unsubscribe();
  }, [controller.client]);

  // Derived from the survey row rather than the row object itself: the row comes
  // from a TableController, so its identity changes on every realtime update or
  // refetch. Keying the loader effect on the object re-ran the fetch and handed
  // <SurveyComponent> a fresh `initialData` object mid-edit (issue #881).
  const surveyId = survey?.id;
  // The table controller yields `undefined` both while it is still loading and
  // for a row that does not exist, so a miss is only knowable once its initial
  // fetch has completed.
  const surveyMissing = surveysReady && survey == null;
  const allowResponseEditing = survey?.allow_response_editing ?? false;

  // Load existing response for this user
  useEffect(() => {
    // Neither an id nor a confirmed miss: the course controller hasn't produced
    // the row yet. Leave the loading gate up — dropping it here would render the
    // survey before the saved draft has been fetched, and answers given in that
    // window get overwritten when it lands.
    if (!surveyId && !surveyMissing) return;

    if (!surveyId || !private_profile_id) {
      setIsLoading(false);
      return;
    }

    // responseStateRef describes one specific response. Discard it only when the identity of
    // that response changes (client-side navigation to another survey, or a different
    // profile); a re-run for the same response -- a new controller.client identity, say --
    // must not forget that it is already submitted.
    const responseKey = `${surveyId}:${private_profile_id}`;
    if (responseStateKeyRef.current !== responseKey) {
      responseStateKeyRef.current = responseKey;
      responseStateRef.current = "unknown";
    }

    let cancelled = false;
    setIsLoading(true);

    const loadExistingResponse = async () => {
      try {
        // Fetch existing response for this student
        const { data, error } = await controller.client
          .from("survey_responses")
          .select("*")
          .eq("survey_id", surveyId)
          .eq("profile_id", private_profile_id)
          .single();

        if (cancelled) return;

        if (error && error.code !== "PGRST116") {
          // PGRST116 = no rows found, which is fine
          console.error("Error loading response:", error);
          toaster.create({
            title: "Could not load your saved answers",
            description: getStudentFacingErrorMessage(error),
            type: "error"
          });
        }

        // Classify the row before the form can be edited, so autosave knows whether it is
        // updating a draft or an already-submitted response. Without this every page load
        // starts out believing it holds a draft.
        responseStateRef.current = responseStateFromLoad({ data, error });

        setExistingResponse(data || null);
      } catch (error) {
        console.error("Error loading existing response:", error);
        // The row could not be read, so neither is_submitted value is safe to write.
        if (!cancelled) responseStateRef.current = "unknown";
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    loadExistingResponse();

    return () => {
      cancelled = true;
    };
  }, [surveyId, surveyMissing, private_profile_id, controller.client]);

  // Handle survey not found or not published
  useEffect(() => {
    if (!isLoading && surveyMissing) {
      toaster.create({
        title: "Survey Not Found",
        description: "This survey is not available or has been removed.",
        type: "error"
      });
      router.push(`/course/${course_id}/surveys`);
    }
  }, [isLoading, surveyMissing, course_id, router]);

  // The row a write sends, or null when it must be skipped. An autosave never downgrades a
  // submitted response: on an editable survey it persists the edit as still-submitted and omits
  // submitted_at, so the upsert leaves the original submission time in place. A write against a
  // row we could not read is dropped.
  const buildResponseRow = useCallback(
    (responseData: ResponseData, isSubmitted: boolean): SurveyResponseUpsert | null => {
      if (!surveyId || !private_profile_id) return null;

      const flags = resolveResponseWriteFlags({ isSubmitted, loadedState: responseStateRef.current });
      if (flags.skip) return null;

      const row: SurveyResponseUpsert = {
        survey_id: surveyId,
        profile_id: private_profile_id,
        response: responseData,
        is_submitted: flags.isSubmitted
      };

      if (flags.stampSubmittedAt) {
        row.submitted_at = new Date().toISOString();
      }

      return row;
    },
    [surveyId, private_profile_id]
  );

  // Save response helper using controller client
  const saveResponseToDb = useCallback(
    async (responseData: ResponseData, isSubmitted: boolean, signal: AbortSignal) => {
      const upsertData = buildResponseRow(responseData, isSubmitted);
      if (!upsertData) return;

      const { data, error } = await controller.client
        .from("survey_responses")
        .upsert(upsertData, {
          onConflict: "survey_id,profile_id"
        })
        .select()
        .abortSignal(signal)
        .single();

      if (error) {
        throw error;
      }

      return data;
    },
    [buildResponseRow, controller.client]
  );

  const handleSurveyComplete = useCallback(
    async (surveyModel: Model) => {
      if (!private_profile_id || !surveyId) {
        console.error("Cannot submit survey: Missing profile_id or survey");
        return;
      }

      // Extract only the survey data from the model, not the entire model object
      const surveyData = surveyModel.data;

      setIsSubmitting(true);
      isSubmittingRef.current = true;
      // Stop the autosave queue and wait out the write in flight, so the submit upsert is the
      // last write. The wait is bounded: every write gives up after SAVE_TIMEOUT_MS.
      const autosaveQueue = autosaveQueueRef.current;
      autosaveQueue?.pause();
      try {
        await autosaveQueue?.whenIdle();
        await runWithTimeout((signal) => saveResponseToDb(surveyData, true, signal), SAVE_TIMEOUT_MS);
        // Set before isSubmittingRef is cleared, so any autosave that fires after the submit
        // writes is_submitted:true rather than reverting the row.
        responseStateRef.current = "submitted";
        // The submit carried the newest answers; a draft snapshot taken before it must not follow.
        autosaveQueue?.discardPending();

        toaster.create({
          title: "Survey Submitted",
          description: "Your survey has been submitted successfully.",
          type: "success"
        });

        // Redirect back to surveys list
        router.push(`/course/${course_id}/surveys`);
      } catch (error) {
        console.error("Error submitting survey:", error);

        const errorMessage = getStudentFacingErrorMessage(error);
        toaster.create({
          title: "Submission Failed",
          description: `${errorMessage} Please try again.`,
          type: "error"
        });
      } finally {
        setIsSubmitting(false);
        isSubmittingRef.current = false;
        autosaveQueue?.resume();
      }
    },
    [private_profile_id, surveyId, course_id, router, saveResponseToDb]
  );

  const canAutosave = useCallback(
    () =>
      // Rechecked when a save's turn comes: Complete may have started, or the response may have
      // been submitted, while it waited behind a slow save.
      !isSubmittingRef.current &&
      shouldAutosaveResponse({ loadedState: responseStateRef.current, allowResponseEditing }) &&
      // A row that could not be read gets no draft write at all (see resolveResponseWriteFlags).
      !resolveResponseWriteFlags({ isSubmitted: false, loadedState: responseStateRef.current }).skip,
    [allowResponseEditing]
  );
  canAutosaveRef.current = canAutosave;
  saveDraftRef.current = async (responseData, { signal, keepalive }) => {
    const accessToken = accessTokenRef.current;
    if (keepalive && accessToken && SUPABASE_URL && SUPABASE_ANON_KEY) {
      const row = buildResponseRow(responseData, false);
      if (!row) return;
      await upsertSurveyResponseWithKeepalive({
        supabaseUrl: SUPABASE_URL,
        anonKey: SUPABASE_ANON_KEY,
        accessToken,
        row,
        signal
      });
      return;
    }
    await saveResponseToDb(responseData, false, signal);
  };

  const handleValueChanged = useCallback(
    (surveyModel: Model, options?: ValueChangedEvent) => {
      void options;
      if (!private_profile_id || !surveyId) return;
      // Only a submit in flight blocks autosave outright. An already-submitted response does
      // not: on an editable survey the student may still be changing answers, and
      // saveResponseToDb keeps that write in the submitted state rather than dropping it.
      if (!canAutosave()) return;

      // Debounced auto-save: SurveyJS fires onValueChanged on every keystroke and again on blur;
      // only the trailing edit needs persisting. Extract only the survey data from the model,
      // not the entire model object.
      autosaveQueueRef.current?.schedule(surveyModel.data);
    },
    [private_profile_id, surveyId, canAutosave]
  );

  const handleBackToSurveys = useCallback(() => {
    router.push(`/course/${course_id}/surveys`);
  }, [router, course_id]);

  // Show loading while survey is being fetched
  if (isLoading || (survey === undefined && !surveyMissing)) {
    return (
      <Box py={8} maxW="1200px" my={2} mx="auto">
        <Box display="flex" alignItems="center" justifyContent="center" p={8}>
          <Text>Loading survey...</Text>
        </Box>
      </Box>
    );
  }

  if (!survey) {
    return (
      <Box py={8} maxW="1200px" my={2} mx="auto">
        <VStack align="center" gap={6} w="100%" minH="100vh" p={8}>
          <Box w="100%" maxW="800px" bg="bg.muted" border="1px solid" borderColor="border" borderRadius="lg" p={8}>
            <VStack align="center" gap={4}>
              <Heading size="xl" color="fg" textAlign="center">
                Survey Not Found
              </Heading>
              <Text color="fg" textAlign="center">
                This survey is not available or has been removed.
              </Text>
              <Button
                variant="outline"
                bg="transparent"
                borderColor="border.emphasized"
                color="fg.muted"
                _hover={{ bg: "gray.subtle" }}
                onClick={handleBackToSurveys}
              >
                ← Back to Surveys
              </Button>
            </VStack>
          </Box>
        </VStack>
      </Box>
    );
  }

  // Check if survey is read-only (submitted and editing not allowed). An instructor
  // viewing as a student is also read-only and must not submit/overwrite the student's response.
  const surveyAlreadySubmitted = existingResponse?.is_submitted && !survey.allow_response_editing;
  const isReadOnly = isSurveyResponseReadOnly({
    responseIsSubmitted: Boolean(existingResponse?.is_submitted),
    allowResponseEditing: survey.allow_response_editing,
    isViewingAsStudent
  });

  return (
    <Box py={8} maxW="1200px" my={2} mx="auto">
      <VStack align="stretch" gap={6} w="100%">
        {/* Header */}
        <VStack align="stretch" gap={4}>
          <Button
            variant="outline"
            size="sm"
            bg="transparent"
            borderColor="border.emphasized"
            color="fg.muted"
            _hover={{ bg: "gray.subtle" }}
            onClick={handleBackToSurveys}
            alignSelf="flex-start"
          >
            ← Back to Surveys
          </Button>

          {surveyAlreadySubmitted && (
            <Box
              colorPalette="yellow"
              bg="yellow.subtle"
              border="1px solid"
              borderColor="yellow.emphasized"
              borderRadius="md"
              p={3}
            >
              <Text color="yellow.fg" fontSize="sm" fontWeight="medium">
                This survey has been submitted and cannot be edited.
              </Text>
            </Box>
          )}

          {existingResponse?.is_submitted && survey.allow_response_editing && (
            <Box
              colorPalette="green"
              bg="green.subtle"
              border="1px solid"
              borderColor="green.emphasized"
              borderRadius="md"
              p={3}
            >
              <Text color="green.fg" fontSize="sm" fontWeight="medium">
                You can edit your response since editing is allowed for this survey.
              </Text>
            </Box>
          )}
        </VStack>

        {/* Autosave status. A polite live region: its text changes when a save starts, lands or
            fails, not on every keystroke. Kept in the DOM, even while empty, so a screen reader
            is already watching it when the first message arrives. */}
        {!isReadOnly && (
          <HStack gap={3} minH={6} justify="flex-end">
            <Text role="status" aria-live="polite" fontSize="sm" color={AUTOSAVE_STATUS_COLOR[autosaveStatus]}>
              {AUTOSAVE_STATUS_TEXT[autosaveStatus]}
            </Text>
            {autosaveStatus === "failed" && (
              <Button size="xs" variant="outline" onClick={() => autosaveQueueRef.current?.retryNow()}>
                Try again
              </Button>
            )}
          </HStack>
        )}

        {/* Survey */}
        <Box w="100%" bg="bg.muted" border="1px solid" borderColor="border" borderRadius="lg" p={8}>
          <SurveyComponent
            surveyJson={survey.json}
            initialData={existingResponse?.response}
            readOnly={isReadOnly || isSubmitting}
            onComplete={handleSurveyComplete}
            onValueChanged={handleValueChanged}
            isPopup={false}
          />
        </Box>
      </VStack>
    </Box>
  );
}
