import { createClient } from "@/utils/supabase/client";
import { useEffect, useRef, useState } from "react";
import * as Sentry from "@sentry/nextjs";

type UnsubscribeStatus = "loading" | "success" | "error";

interface UseUnsubscribeOptions {
  entityType: "thread" | "topic";
  entityId: number;
  courseId: number;
  fetchName: (supabase: ReturnType<typeof createClient>, entityId: number, courseId: number) => Promise<string | null>;
  performUnsubscribe: (
    supabase: ReturnType<typeof createClient>,
    userId: string,
    entityId: number,
    courseId: number
  ) => Promise<void>;
  defaultEntityName: string;
}

interface UseUnsubscribeReturn {
  status: UnsubscribeStatus;
  errorMessage: string;
  entityName: string;
  reset: () => void;
  retry: () => void;
}

export function useUnsubscribe({
  entityType,
  entityId,
  courseId,
  fetchName,
  performUnsubscribe,
  defaultEntityName
}: UseUnsubscribeOptions): UseUnsubscribeReturn {
  const [status, setStatus] = useState<UnsubscribeStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [entityName, setEntityName] = useState<string>(defaultEntityName);

  // Use refs to store latest callbacks to avoid stale closures
  const fetchNameRef = useRef(fetchName);
  const performUnsubscribeRef = useRef(performUnsubscribe);

  // Track current run ID to prevent race conditions
  const currentRunIdRef = useRef(0);

  // Store execute function in ref so retry can call it
  const executeUnsubscribeRef = useRef<() => Promise<void>>();

  useEffect(() => {
    fetchNameRef.current = fetchName;
    performUnsubscribeRef.current = performUnsubscribe;
  }, [fetchName, performUnsubscribe]);

  useEffect(() => {
    const executeUnsubscribe = async () => {
      // Create a unique run ID for this execution
      const runId = ++currentRunIdRef.current;

      // Helper to check if this run is still current
      const isCurrentRun = () => runId === currentRunIdRef.current;

      // Validate entity ID
      if (!Number.isFinite(entityId) || entityId <= 0) {
        if (!isCurrentRun()) return;
        setErrorMessage(`Invalid ${entityType} ID`);
        setStatus("error");
        return;
      }

      // Validate course ID
      if (!Number.isFinite(courseId) || courseId <= 0) {
        if (!isCurrentRun()) return;
        setErrorMessage("Invalid course ID");
        setStatus("error");
        return;
      }

      const supabase = createClient();
      const {
        data: { user }
      } = await supabase.auth.getUser();

      if (!user) {
        if (!isCurrentRun()) return;
        setErrorMessage("You must be logged in to unsubscribe. Please log in and try again.");
        setStatus("error");
        return;
      }

      // Set up Sentry only if still current
      if (!isCurrentRun()) return;
      Sentry.setUser({ id: user.id });
      Sentry.setTag("operation", `unsubscribe_${entityType}`);
      Sentry.setTag(`${entityType}_id`, entityId.toString());
      Sentry.setTag("class_id", courseId.toString());

      try {
        // Fetch entity name
        const name = await fetchNameRef.current(supabase, entityId, courseId);
        if (!isCurrentRun()) return;
        if (name) {
          setEntityName(name);
        }

        // Perform unsubscribe
        await performUnsubscribeRef.current(supabase, user.id, entityId, courseId);
        if (!isCurrentRun()) return;

        setStatus("success");
      } catch (error) {
        if (!isCurrentRun()) return;
        Sentry.captureException(error, {
          tags: { operation: `unsubscribe_${entityType}` }
        });
        setErrorMessage("An unexpected error occurred. Please try again later.");
        setStatus("error");
      }
    };

    // Store function in ref for retry to use
    executeUnsubscribeRef.current = executeUnsubscribe;

    executeUnsubscribe();

    // Cleanup: mark any in-flight run as cancelled by incrementing the run ID
    return () => {
      // Capture ref value to satisfy linter (though safe for number refs)
      const runIdRef = currentRunIdRef;
      runIdRef.current++;
    };
  }, [entityId, courseId, entityType]);

  const reset = () => {
    setStatus("loading");
    setErrorMessage("");
    setEntityName(defaultEntityName);
  };

  const retry = () => {
    // Cancel any in-flight operation
    currentRunIdRef.current++;
    reset();
    executeUnsubscribeRef.current?.();
  };

  return {
    status,
    errorMessage,
    entityName,
    reset,
    retry
  };
}
