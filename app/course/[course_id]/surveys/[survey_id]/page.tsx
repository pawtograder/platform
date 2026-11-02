"use client";

import { Box, Heading, Text, VStack, Button, HStack } from "@chakra-ui/react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useRef } from "react";
import { Alert } from "@/components/ui/alert";
import { toaster } from "@/components/ui/toaster";
import { getStudentFacingErrorMessage } from "@/lib/studentFacingErrorMessages";
import dynamic from "next/dynamic";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { SurveyResponse, ResponseData } from "@/types/survey";
import { CompleteEvent, Model, ValueChangedEvent } from "survey-core";
import { useCourseController, useSurvey } from "@/hooks/useCourseController";
import { useIsTableControllerReady } from "@/lib/TableController";
import {
  isSameResponseData,
  isSurveyResponseReadOnly,
  resolveResponseWriteFlags,
  responseStateFromLoad,
  shouldAutosaveResponse,
  type LoadedResponseState
} from "@/lib/surveyResponseState";
import {
  runWithTimeout,
  SaveTimeoutError,
  SurveyAutosaveQueue,
  type AutosaveStatus,
  type RetryPolicy,
  type SaveAttempt
} from "@/lib/surveyAutosaveQueue";
import { upsertSurveyResponseWithKeepalive, type SurveyResponseUpsert } from "@/lib/surveyResponseKeepalive";

const AUTOSAVE_DEBOUNCE_MS = 1000;
// Upper bound on one save request, autosave or Complete. A survey upsert normally takes well under
// a second; past this the request is canceled, so it cannot hold up the saves queued behind it.
const SAVE_TIMEOUT_MS = 10_000;
// A failed autosave is retried after 1, 2, 4 and 8 s, then waits for the next edit or for the
// browser to come back online.
const AUTOSAVE_RETRY: RetryPolicy = { baseDelayMs: 1000, maxDelayMs: 8000, maxRetries: 4 };

const AUTOSAVE_STATUS_TEXT: Record<AutosaveStatus, string> = {
  idle: "",
  saving: "Saving…",
  saved: "All changes saved",
  retrying: "Not saved yet. Retrying…",
  offline: "You're offline. Keep this page open and your answers will save when you reconnect.",
  failed: "Your latest answers aren't saved."
};
const AUTOSAVE_STATUS_COLOR: Record<AutosaveStatus, string> = {
  idle: "fg.muted",
  saving: "fg.muted",
  saved: "fg.muted",
  // fg.warning is orange.600, about 3.6:1 on white: below AA for small text. orange.fg is
  // orange.700 in light mode and orange.300 in dark.
  retrying: "orange.fg",
  offline: "orange.fg",
  failed: "fg.error"
};
// Shown in the same status region, in the `failed` color, after an edit the page can't save because
// the student's saved response didn't load.
const UNSAVABLE_STATUS_TEXT =
  "Your saved answers didn't load, so changes can't be saved. Reload the page to try again.";
// The project the browser Supabase client talks to (utils/supabase/client.ts), for the keepalive
// request sent while the page unloads.
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** The Postgres error code PostgREST returned, or undefined when the error didn't come from the database. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error) || !error.code) return undefined;
  return String(error.code);
}

// What the database answers when an upsert would change a submitted response the student may not
// change: the trigger that keeps it submitted (check_violation) or, on a survey without editing,
// the update policy (insufficient_privilege).
const REFUSED_AS_SUBMITTED_CODES = new Set(["23514", "42501"]);

/**
 * Whether the response row has to be read to learn where a failed Complete left it. Only an error
 * the database returned says the upsert was rolled back. A timeout, a dropped connection or a
 * gateway's error page can arrive after it committed, and a refusal because the row is already
 * submitted may mean an earlier attempt got through.
 */
function submitOutcomeNeedsReadBack(error: unknown): boolean {
  const code = errorCode(error);
  return !code || REFUSED_AS_SUBMITTED_CODES.has(code);
}

/** Whether a stored row shows that a submit carrying `sentData` landed: submitted, with those answers. */
function holdsSubmission(row: SurveyResponse | null | undefined, sentData: ResponseData): row is SurveyResponse {
  return Boolean(row?.is_submitted) && isSameResponseData(row?.response, sentData);
}

const NOT_SUBMITTED_TITLE = "Your survey wasn't submitted";
const MAYBE_SUBMITTED_TITLE = "Your survey may not have been submitted";
const PRESS_COMPLETE_AGAIN = "Your answers are still here. Press Complete to try again.";

type SubmitAlert = {
  title: string;
  message: string;
  /** Move focus to the alert. Set when Complete fails, not when a later check only updates the text. */
  focus: boolean;
};

/**
 * What the alert says after a failed Complete. `failed`: the submit did not land. `unknown`: it may
 * have, and the row couldn't be read to find out. `unknown-until-online`: it may have, and the row
 * is read once the browser is back online.
 */
type SubmitOutcome = "failed" | "unknown" | "unknown-until-online";

const COULD_NOT_CHECK = `The page couldn't reach the server to check. ${PRESS_COMPLETE_AGAIN}`;

/** The alert a failed Complete shows, with the focus moved to it. */
function submitFailureAlert(error: unknown, outcome: SubmitOutcome): SubmitAlert {
  if (outcome === "unknown-until-online") {
    return {
      title: MAYBE_SUBMITTED_TITLE,
      message:
        "The connection dropped before the server replied. Your answers are still here. Keep this page open, and it will check when you reconnect.",
      focus: true
    };
  }
  if (outcome === "unknown") return { title: MAYBE_SUBMITTED_TITLE, message: COULD_NOT_CHECK, focus: true };
  return { title: NOT_SUBMITTED_TITLE, message: submitFailureMessage(error, navigator.onLine), focus: true };
}

/**
 * Why a Complete that did not land failed. A network failure reaches us from supabase-js as
 * `{ message: "TypeError: Failed to fetch", details: <stack trace> }`, which
 * getStudentFacingErrorMessage would show as the stack trace, so those are named here.
 */
function submitFailureMessage(error: unknown, online: boolean): string {
  if (!online) {
    return "You're offline. Your answers are still here. Keep this page open and they will save as a draft when you reconnect. Then press Complete again.";
  }
  if (error instanceof SaveTimeoutError) return `The server took too long to respond. ${PRESS_COMPLETE_AGAIN}`;
  const message = typeof error === "object" && error !== null && "message" in error ? String(error.message) : "";
  if (!errorCode(error) && /^(TypeError|AbortError)\b/.test(message)) {
    return `The server couldn't be reached. ${PRESS_COMPLETE_AGAIN}`;
  }
  return `${getStudentFacingErrorMessage(error)} ${PRESS_COMPLETE_AGAIN}`;
}

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
  // Why the last Complete failed, shown above the form until the next attempt.
  const [submitError, setSubmitError] = useState<SubmitAlert | null>(null);
  const submitErrorRef = useRef<HTMLDivElement | null>(null);
  // The response turned out to be submitted after the page loaded it as a draft: a Complete whose
  // reply was lost, or a submit from another tab. On a survey that allows editing the form keeps the
  // student's answers, so this, not existingResponse, says it is submitted.
  const [submittedSinceLoad, setSubmittedSinceLoad] = useState(false);
  // An edit arrived that can't be saved because the student's saved response didn't load.
  const [saveBlocked, setSaveBlocked] = useState(false);

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
  // Holds the newest unsaved answers and sends them one request at a time, so a slow older request
  // can never land after a newer one. Complete pauses it and waits for the request in flight.
  const autosaveQueueRef = useRef<SurveyAutosaveQueue<ResponseData> | null>(null);
  // The queue outlives renders, so it reads the current save function and guards through refs.
  const saveDraftRef = useRef<(responseData: ResponseData, attempt: SaveAttempt) => Promise<void>>(async () => {});
  const canAutosaveRef = useRef<() => boolean>(() => false);
  // The student's access token, kept current so the request sent while the page unloads does not
  // have to wait for the Supabase client to read it.
  const accessTokenRef = useRef<string | null>(null);
  // A Complete failed offline after it may have reached the database. The autosave queue stays
  // paused until the row has been read, once the browser is back online: a draft sent first would
  // only be refused.
  const submitCheckPendingRef = useRef(false);
  const checkSubmitOnReconnectRef = useRef<() => Promise<void>>(async () => {});

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

    const onReconnect = () => {
      void checkSubmitOnReconnectRef.current();
      queue.retryNow();
    };
    const noteOffline = () => queue.noteOffline();
    window.addEventListener("online", onReconnect);
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
      window.removeEventListener("online", onReconnect);
      window.removeEventListener("offline", noteOffline);
      // Flush rather than merely cancel when the student navigates away inside the app. That
      // request still goes out, but nothing is retried once the page is gone.
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
      setSubmittedSinceLoad(false);
      setSaveBlocked(false);
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

  // The row an upsert sends, or null when it must be skipped. An autosave never downgrades a
  // submitted response: on an editable survey it persists the edit as still-submitted and omits
  // submitted_at, so the upsert leaves the original submission time in place. An upsert against a
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

  // The student's response row as stored now: null when there is none, undefined when it can't be
  // read. Read when a save's reply (or the lack of one) doesn't say where the row stands.
  const readStoredResponse = useCallback(async (): Promise<SurveyResponse | null | undefined> => {
    if (!surveyId || !private_profile_id) return undefined;
    try {
      const { data, error } = await runWithTimeout(
        async (signal) =>
          controller.client
            .from("survey_responses")
            .select("*")
            .eq("survey_id", surveyId)
            .eq("profile_id", private_profile_id)
            .abortSignal(signal)
            .maybeSingle(),
        SAVE_TIMEOUT_MS
      );
      return error ? undefined : data;
    } catch {
      return undefined;
    }
  }, [surveyId, private_profile_id, controller.client]);

  // The server holds a submitted response that this page took for a draft: a Complete whose reply
  // was lost, or a submit from another tab. Show it as submitted, as a reload would.
  const showSubmittedResponse = useCallback(
    (row: SurveyResponse) => {
      responseStateRef.current = "submitted";
      setSubmitError(null);
      setSubmittedSinceLoad(true);
      // Without editing the form locks and shows what was submitted. With editing it keeps the
      // student's answers, which are newer than the row; handing it the row would overwrite them
      // the next time it turns read-only.
      if (!allowResponseEditing) setExistingResponse(row);
      toaster.create({
        title: "Survey Submitted",
        description: "Your survey has been submitted.",
        type: "success"
      });
    },
    [allowResponseEditing]
  );

  const handleSurveyComplete = useCallback(
    async (surveyModel: Model, options?: CompleteEvent) => {
      if (!private_profile_id || !surveyId) {
        console.error("Cannot submit survey: Missing profile_id or survey");
        return;
      }

      // Extract only the survey data from the model, not the entire model object
      const surveyData = surveyModel.data;

      setIsSubmitting(true);
      setSubmitError(null);
      isSubmittingRef.current = true;
      // SurveyJS has already switched to its completed page. Say the answers are on their way
      // rather than leaving the thank-you text to claim they arrived.
      options?.showSaveInProgress("Submitting your answers…");
      // Stop the autosave queue and wait out the request in flight, so the submit upsert is the
      // last one. The wait is bounded: every request gives up after SAVE_TIMEOUT_MS.
      const autosaveQueue = autosaveQueueRef.current;
      autosaveQueue?.pause();
      let submitted = false;
      // Assigned in the catch below. The cast keeps TypeScript from narrowing it to "failed" in finally.
      let outcome = "failed" as SubmitOutcome;
      try {
        await autosaveQueue?.whenIdle();
        // Offline, the browser doesn't send the request at all.
        const sentOnline = navigator.onLine;
        try {
          await runWithTimeout((signal) => saveResponseToDb(surveyData, true, signal), SAVE_TIMEOUT_MS);
        } catch (error) {
          // A failed request is not a failed submit: the upsert may have committed and only the
          // reply been lost. Reporting that as a failure would send the student back to a form
          // whose row is already submitted, and the draft autosave after it would be refused.
          if (!submitOutcomeNeedsReadBack(error)) throw error;
          if (!navigator.onLine) {
            // The row can't be read until the network is back. A submit sent online, or an
            // earlier one not yet checked, may have got through.
            if (sentOnline || submitCheckPendingRef.current) outcome = "unknown-until-online";
            throw error;
          }
          // submitted_at can't tell: on a first submit the database stamps it with the server's
          // clock, not this browser's. The answers can.
          const row = await readStoredResponse();
          if (!holdsSubmission(row, surveyData)) {
            if (row === undefined) outcome = "unknown";
            throw error;
          }
        }
        submitted = true;
        submitCheckPendingRef.current = false;
        // Set before isSubmittingRef is cleared, so any autosave that fires after the submit
        // writes is_submitted:true rather than reverting the row.
        responseStateRef.current = "submitted";
        // The submit carried the newest answers; a draft snapshot taken before it must not follow.
        autosaveQueue?.discardPending();
        options?.showSaveSuccess("Your survey has been submitted.");

        toaster.create({
          title: "Survey Submitted",
          description: "Your survey has been submitted successfully.",
          type: "success"
        });

        // Redirect back to surveys list
        router.push(`/course/${course_id}/surveys`);
      } catch (error) {
        console.error("Error submitting survey:", error);
        // Back to the form, on the same page and with the answers, so the student can see them
        // and press Complete again. clear(false, false) keeps the data and the current page.
        options?.clearSaveMessages();
        surveyModel.clear(false, false);
        setSubmitError(submitFailureAlert(error, outcome));
      } finally {
        setIsSubmitting(false);
        isSubmittingRef.current = false;
        // The answers were not submitted, so they go back to being saved as a draft. Offline, the
        // queue holds them until the browser reconnects.
        if (!submitted) autosaveQueue?.schedule(surveyModel.data);
        if (outcome === "unknown-until-online") {
          // The queue stays paused until checkSubmitOnReconnect has read the row.
          submitCheckPendingRef.current = true;
          if (navigator.onLine) void checkSubmitOnReconnectRef.current();
        } else {
          autosaveQueue?.resume();
          if (!submitted) autosaveQueue?.flush();
        }
      }
    },
    [private_profile_id, surveyId, course_id, router, saveResponseToDb, readStoredResponse]
  );

  // Back online after a Complete that may have landed while offline: read the row before any draft
  // goes out. If it is submitted, show that; otherwise the answers go back to autosaving.
  checkSubmitOnReconnectRef.current = async () => {
    if (!submitCheckPendingRef.current || isSubmittingRef.current) return;
    submitCheckPendingRef.current = false;
    const row = await readStoredResponse();
    // A new Complete started meanwhile. It decides, and resumes the queue when it ends.
    if (isSubmittingRef.current) return;
    if (row?.is_submitted) {
      showSubmittedResponse(row);
    } else {
      setSubmitError(
        row === undefined
          ? { title: MAYBE_SUBMITTED_TITLE, message: COULD_NOT_CHECK, focus: false }
          : { title: NOT_SUBMITTED_TITLE, message: PRESS_COMPLETE_AGAIN, focus: false }
      );
    }
    autosaveQueueRef.current?.resume();
    autosaveQueueRef.current?.flush();
  };

  // The failed form is re-rendered from scratch, so focus would otherwise fall back to the page.
  // Moving it to the alert puts keyboard and screen-reader users next to the form they return to.
  useEffect(() => {
    if (submitError?.focus) submitErrorRef.current?.focus();
  }, [submitError]);

  const canAutosave = useCallback(
    () =>
      // Rechecked when a save's turn comes: Complete may have started, or the response may have
      // been submitted, while it waited behind a slow save.
      !isSubmittingRef.current &&
      shouldAutosaveResponse({ loadedState: responseStateRef.current, allowResponseEditing }) &&
      // A row that could not be read gets no draft upsert at all (see resolveResponseWriteFlags).
      !resolveResponseWriteFlags({ isSubmitted: false, loadedState: responseStateRef.current }).skip,
    [allowResponseEditing]
  );
  canAutosaveRef.current = canAutosave;
  const sendDraft = async (responseData: ResponseData, { signal, keepalive }: SaveAttempt) => {
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
  saveDraftRef.current = async (responseData, attempt) => {
    try {
      await sendDraft(responseData, attempt);
    } catch (error) {
      // The database refuses a draft over a submitted response. If the row is submitted, it was
      // submitted where this page couldn't see it, so show that instead of retrying a request that
      // can only be refused again.
      const code = errorCode(error);
      if (!code || !REFUSED_AS_SUBMITTED_CODES.has(code)) throw error;
      const row = await readStoredResponse();
      if (!row?.is_submitted) throw error;
      showSubmittedResponse(row);
      // A survey that allows editing still takes the edit, now as a change to the submitted response.
      if (canAutosaveRef.current()) await sendDraft(responseData, attempt);
    }
  };

  const handleValueChanged = useCallback(
    (surveyModel: Model, options?: ValueChangedEvent) => {
      void options;
      if (!private_profile_id || !surveyId) return;
      // Only a submit in flight blocks autosave outright. An already-submitted response does
      // not: on an editable survey the student may still be changing answers, and
      // saveResponseToDb keeps that write in the submitted state rather than dropping it.
      if (!canAutosave()) {
        // The saved response couldn't be read, so no edit is saved (see resolveResponseWriteFlags).
        // The form is still editable, so say so rather than leave the status blank.
        if (!isSubmittingRef.current && responseStateRef.current === "unknown") setSaveBlocked(true);
        return;
      }
      setSaveBlocked(false);

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
  const responseIsSubmitted = Boolean(existingResponse?.is_submitted) || submittedSinceLoad;
  const surveyAlreadySubmitted = responseIsSubmitted && !survey.allow_response_editing;
  const isReadOnly = isSurveyResponseReadOnly({
    responseIsSubmitted,
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

          {responseIsSubmitted && survey.allow_response_editing && (
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
            <Text
              role="status"
              aria-live="polite"
              fontSize="sm"
              color={saveBlocked ? "fg.error" : AUTOSAVE_STATUS_COLOR[autosaveStatus]}
            >
              {saveBlocked ? UNSAVABLE_STATUS_TEXT : AUTOSAVE_STATUS_TEXT[autosaveStatus]}
            </Text>
            {autosaveStatus === "failed" && (
              <Button size="xs" variant="outline" onClick={() => autosaveQueueRef.current?.retryNow()}>
                Try again
              </Button>
            )}
          </HStack>
        )}

        {submitError && (
          <Alert ref={submitErrorRef} tabIndex={-1} role="alert" status="error" title={submitError.title}>
            {submitError.message}
          </Alert>
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
