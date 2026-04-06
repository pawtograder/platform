"use client";
import { toaster } from "@/components/ui/toaster";
import { useReferencingRubricChecks } from "@/hooks/useAssignment";
import {
  useRubricChecksQuery,
  useRubricCriteriaQuery,
  useReviewAssignmentsQuery,
  useRubricsQuery
} from "@/hooks/assignment-data";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useCourseController } from "@/hooks/useCourseController";
import { createClient } from "@/utils/supabase/client";
import {
  HydratedRubricPart,
  RegradeRequestComment,
  Rubric,
  RubricChecks,
  RubricCriteria,
  SubmissionArtifact,
  SubmissionArtifactComment,
  SubmissionComments,
  SubmissionFile,
  SubmissionFileComment,
  SubmissionReview,
  SubmissionWithGraderResultsAndFiles
} from "@/utils/supabase/DatabaseTypes";
import { Database, Enums, Tables } from "@/utils/supabase/SupabaseTypes";
import { Spinner, Text } from "@chakra-ui/react";
import { useShow } from "@refinedev/core";
import { SupabaseClient } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { SubmissionReviewProvider } from "./useSubmissionReview";
import {
  useSubmissionCommentsQuery,
  useSubmissionFileCommentsQuery,
  useSubmissionArtifactCommentsQuery,
  useSubmissionReviewsQuery,
  useSubmissionRegradeRequestCommentsQuery,
  SubmissionDataBridge
} from "@/hooks/submission-data";

/**
 * Lightweight adapter providing the same mutation API as the old
 * TableController-based SubmissionController.  No realtime subscriptions;
 * data flows through TanStack Query hooks.
 */
function makeTableShim<TableName extends keyof Database["public"]["Tables"]>(
  client: SupabaseClient<Database>,
  table: TableName,
  queryKey: readonly unknown[]
) {
  type Row = Database["public"]["Tables"][TableName]["Row"];
  type Insert = Database["public"]["Tables"][TableName]["Insert"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = client as any;
  let _queryClient: ReturnType<typeof useQueryClient> | null = null;

  return {
    /** Allow the provider to inject the QueryClient (set once). */
    _setQueryClient(qc: ReturnType<typeof useQueryClient>) {
      _queryClient = qc;
    },
    async create(row: Insert): Promise<Row> {
      const { data, error } = await db.from(table).insert(row).select("*").single();
      if (error) throw error;
      _queryClient?.invalidateQueries({ queryKey });
      return data as Row;
    },
    async update(id: number | string, values: Partial<Row>): Promise<Row> {
      const { data, error } = await db.from(table).update(values).eq("id", id).select("*").single();
      if (error) throw error;
      _queryClient?.invalidateQueries({ queryKey });
      return data as Row;
    },
    async delete(id: number | string): Promise<void> {
      // Soft-delete (matches old TableController behaviour)
      const { error } = await db.from(table).update({ deleted_at: new Date().toISOString() }).eq("id", id);
      if (error) throw error;
      _queryClient?.invalidateQueries({ queryKey });
    },
    /** Re-fetch a single row and update the TanStack cache. */
    async invalidate(id: number | string): Promise<void> {
      _queryClient?.invalidateQueries({ queryKey });
    },
    async refetchAll(): Promise<void> {
      _queryClient?.invalidateQueries({ queryKey });
    },
    /** Cached rows — reads from TanStack Query cache. */
    get rows(): Row[] {
      return (_queryClient?.getQueryData?.(queryKey) ?? []) as Row[];
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    list(callback?: (data: Row[], params?: any) => void): { data: Row[]; unsubscribe: () => void } {
      const d = this.rows;
      if (callback) callback(d);
      return { data: d, unsubscribe: () => {} };
    },
    getById(
      id: number | string,
      callback?: (data: Row | undefined) => void
    ): { data: Row | undefined; unsubscribe: () => void } {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const found = this.rows.find((r: any) => r.id === id);
      if (callback) callback(found);
      return { data: found, unsubscribe: () => {} };
    },
    readyPromise: Promise.resolve(),
    close() {}
  };
}

type TableShim<TableName extends keyof Database["public"]["Tables"]> = ReturnType<typeof makeTableShim<TableName>>;

class SubmissionController {
  private _submission?: SubmissionWithGraderResultsAndFiles;
  private _file?: SubmissionFile;
  private _artifact?: SubmissionArtifact;

  readonly submission_comments: TableShim<"submission_comments">;
  readonly submission_file_comments: TableShim<"submission_file_comments">;
  readonly submission_artifact_comments: TableShim<"submission_artifact_comments">;
  readonly submission_reviews: TableShim<"submission_reviews">;
  readonly submission_regrade_request_comments: TableShim<"submission_regrade_request_comments">;

  readonly readyPromise: Promise<void>;

  constructor(client: SupabaseClient<Database>, submission_id: number) {
    this.submission_comments = makeTableShim(client, "submission_comments", ["submission", submission_id, "comments"]);
    this.submission_file_comments = makeTableShim(client, "submission_file_comments", [
      "submission",
      submission_id,
      "file_comments"
    ]);
    this.submission_artifact_comments = makeTableShim(client, "submission_artifact_comments", [
      "submission",
      submission_id,
      "artifact_comments"
    ]);
    this.submission_reviews = makeTableShim(client, "submission_reviews", ["submission", submission_id, "reviews"]);
    this.submission_regrade_request_comments = makeTableShim(client, "submission_regrade_request_comments", [
      "submission",
      submission_id,
      "regrade_request_comments"
    ]);
    this.readyPromise = Promise.resolve();
  }

  /** Inject the QueryClient so shims can invalidate. */
  _setQueryClient(qc: ReturnType<typeof useQueryClient>) {
    this.submission_comments._setQueryClient(qc);
    this.submission_file_comments._setQueryClient(qc);
    this.submission_artifact_comments._setQueryClient(qc);
    this.submission_reviews._setQueryClient(qc);
    this.submission_regrade_request_comments._setQueryClient(qc);
  }

  close() {
    // No subscriptions to tear down.
  }

  get isReady() {
    return this._submission !== undefined;
  }

  set submission(submission: SubmissionWithGraderResultsAndFiles) {
    this._submission = submission;
  }

  set file(file: SubmissionFile | undefined) {
    this._file = file;
  }
  set artifact(artifact: SubmissionArtifact | undefined) {
    this._artifact = artifact;
  }
  get submission() {
    if (!this._submission) {
      throw new Error("Submission not set, must wait for isReady to be true");
    }
    return this._submission;
  }
  get file() {
    return this._file;
  }
  get artifact() {
    return this._artifact;
  }
}

type SubmissionContextType = {
  submissionController: SubmissionController;
};

const SubmissionContext = createContext<SubmissionContextType | null>(null);

export function SubmissionProvider({
  submission_id: initial_submission_id,
  children
}: {
  submission_id?: number;
  children: React.ReactNode;
}) {
  const params = useParams();
  const submission_id = initial_submission_id ?? Number(params.submissions_id);
  const [ready, setReady] = useState(false);
  const queryClient = useQueryClient();

  const controllerRef = useRef<SubmissionController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new SubmissionController(createClient(), submission_id);
  }
  const controller = controllerRef.current;

  // Inject QueryClient so shims can invalidate caches
  controller._setQueryClient(queryClient);

  if (isNaN(submission_id)) {
    toaster.error({
      title: "Invalid Submission ID",
      description: "Submission ID is not a valid number after checking params."
    });
    return <Text>Error: Invalid Submission ID.</Text>;
  }

  return (
    <SubmissionContext.Provider value={{ submissionController: controller }}>
      <SubmissionDataBridge>
        <SubmissionControllerCreator submission_id={submission_id} setReady={setReady} />
        {!ready && <Spinner />}
        {ready && <SubmissionReviewProvider>{children}</SubmissionReviewProvider>}
      </SubmissionDataBridge>
    </SubmissionContext.Provider>
  );
}
export function useSubmissionFileComments({
  file_id,
  onEnter,
  onLeave
}: {
  file_id?: number;
  onEnter?: (comment: SubmissionFileComment[]) => void;
  onLeave?: (comment: SubmissionFileComment[]) => void;
}) {
  const { data: allComments = [] } = useSubmissionFileCommentsQuery();

  const comments = useMemo(
    () =>
      allComments.filter(
        (comment) =>
          (comment.deleted_at === null || comment.deleted_at === undefined) &&
          (file_id === undefined || comment.submission_file_id === file_id)
      ),
    [allComments, file_id]
  );

  // Note: onEnter/onLeave callbacks are not supported in the TanStack Query shim.
  // They were used for real-time enter/leave notifications which TanStack handles differently.

  return comments;
}

export function useSubmissionComments({
  onEnter,
  onLeave
}: {
  onEnter?: (comment: SubmissionComments[]) => void;
  onLeave?: (comment: SubmissionComments[]) => void;
}) {
  const { data: allComments = [] } = useSubmissionCommentsQuery();

  const comments = useMemo(
    () => allComments.filter((comment) => comment.deleted_at === null || comment.deleted_at === undefined),
    [allComments]
  );

  // Note: onEnter/onLeave callbacks are not supported in the TanStack Query shim.

  return comments;
}

/**
 * Provides a live-updating list of artifact comments for the current submission, excluding deleted comments.
 *
 * Invokes optional callbacks when comments are added or removed.
 *
 * @param onEnter - Called with newly entered artifact comments.
 * @param onLeave - Called with artifact comments that have been removed.
 * @returns An array of current, non-deleted artifact comments for the submission.
 */
export function useSubmissionArtifactComments({
  onEnter,
  onLeave
}: {
  onEnter?: (comment: SubmissionArtifactComment[]) => void;
  onLeave?: (comment: SubmissionArtifactComment[]) => void;
}) {
  const { data: allComments = [] } = useSubmissionArtifactCommentsQuery();

  const comments = useMemo(() => allComments.filter((comment) => comment.deleted_at === null), [allComments]);

  // Note: onEnter/onLeave callbacks are not supported in the TanStack Query shim.

  return comments;
}
/**
 * Subscribes to and returns regrade request comments for the current submission, optionally filtered by a specific regrade request ID.
 *
 * Invokes optional callbacks when comments are added or removed from the filtered set.
 *
 * @param submission_regrade_request_id - If provided, filters comments to those matching this regrade request ID.
 * @param onEnter - Optional callback invoked with comments that have entered the filtered set.
 * @param onLeave - Optional callback invoked with comments that have left the filtered set.
 * @returns An array of regrade request comments matching the filter.
 */
export function useSubmissionRegradeRequestComments({
  submission_regrade_request_id,
  onEnter,
  onLeave
}: {
  submission_regrade_request_id?: number;
  onEnter?: (comment: RegradeRequestComment[]) => void;
  onLeave?: (comment: RegradeRequestComment[]) => void;
}) {
  const { data: allComments = [] } = useSubmissionRegradeRequestCommentsQuery();

  const comments = useMemo(
    () =>
      allComments.filter(
        (comment) =>
          submission_regrade_request_id === undefined ||
          comment.submission_regrade_request_id === submission_regrade_request_id
      ),
    [allComments, submission_regrade_request_id]
  );

  // Note: onEnter/onLeave callbacks are not supported in the TanStack Query shim.

  return comments;
}

/**
 * Returns a reactive submission file comment by its ID, updating as the comment changes in real time.
 *
 * @param comment_id - The ID of the submission file comment to subscribe to
 * @returns The submission file comment object, or undefined if not found
 */
export function useSubmissionFileComment(comment_id: number | undefined | null) {
  const { data = [] } = useSubmissionFileCommentsQuery();
  return useMemo(() => (comment_id ? data.find((c) => c.id === comment_id) : undefined), [data, comment_id]);
}
export function useSubmissionArtifactComment(comment_id: number | undefined | null) {
  const { data = [] } = useSubmissionArtifactCommentsQuery();
  return useMemo(() => (comment_id ? data.find((c) => c.id === comment_id) : undefined), [data, comment_id]);
}
export function useSubmissionComment(comment_id: number | undefined | null) {
  const { data = [] } = useSubmissionCommentsQuery();
  return useMemo(() => (comment_id ? data.find((c) => c.id === comment_id) : undefined), [data, comment_id]);
}
export function useSubmissionCommentByType(comment_id: number, type: "file" | "artifact" | "submission") {
  const { data: fileComments = [] } = useSubmissionFileCommentsQuery();
  const { data: artifactComments = [] } = useSubmissionArtifactCommentsQuery();
  const { data: submissionComments = [] } = useSubmissionCommentsQuery();

  return useMemo<(SubmissionFileComment | SubmissionArtifactComment | SubmissionComments) | undefined>(() => {
    if (type === "file") {
      return fileComments.find((c) => c.id === comment_id);
    }
    if (type === "artifact") {
      return artifactComments.find((c) => c.id === comment_id);
    }
    if (type === "submission") {
      return submissionComments.find((c) => c.id === comment_id);
    }
    return undefined;
  }, [fileComments, artifactComments, submissionComments, comment_id, type]);
}
function SubmissionControllerCreator({
  submission_id,
  setReady
}: {
  submission_id: number;
  setReady: (ready: boolean) => void;
}) {
  const ctx = useContext(SubmissionContext);
  if (!ctx) {
    throw new Error("SubmissionContext not found");
  }
  const submissionController = ctx.submissionController;

  // Single comprehensive query to load all data upfront
  const { query } = useShow<SubmissionWithGraderResultsAndFiles>({
    resource: "submissions",
    id: submission_id,
    meta: {
      select: `
        *,
        submission_files(*),
        grader_results!grader_results_submission_id_fkey(*, grader_result_tests(*), grader_result_output(*)),
        submission_artifacts(*)
      `.trim()
    }
  });

  // Set up live subscriptions with proper event handling
  // We need these enabled to receive live events, but we'll ignore the initial data since we already loaded it
  const [liveSubscriptionsReady, setLiveSubscriptionsReady] = useState(false);

  // Process the main query data once it's loaded
  useEffect(() => {
    if (query.data?.data && !query.isLoading) {
      const data = query.data.data;
      submissionController.submission = data;
      setLiveSubscriptionsReady(true);
    }
  }, [query.data, query.isLoading, submissionController]);

  // Set ready when everything is loaded
  useEffect(() => {
    if (!query.isLoading && liveSubscriptionsReady) {
      setReady(true);
    }
  }, [query.isLoading, liveSubscriptionsReady, setReady]);

  if (query.isLoading) {
    return (
      <div className="fixed inset-0 w-full h-full flex justify-center items-center bg-white/80 z-[9999]">
        <Spinner />
        <Text>Loading submission...</Text>
      </div>
    );
  }

  if (query.error) {
    toaster.error({
      title: "Error loading submission",
      description: query.error.message
    });
  }

  if (!query.data) {
    return <></>;
  }

  return <></>;
}
export function useSubmissionMaybe() {
  const ctx = useContext(SubmissionContext);
  if (!ctx) {
    return undefined;
  }
  return ctx.submissionController.submission;
}
export function useSubmission() {
  const controller = useSubmissionController();
  if (!controller) {
    throw new Error("useSubmission must be used within a SubmissionProvider");
  }
  return controller.submission;
}
export function useAllRubricCheckInstances(review_id: number | undefined) {
  const ctx = useContext(SubmissionContext);
  const fileComments = useSubmissionFileComments({});
  const submissionComments = useSubmissionComments({});

  // Use useMemo to ensure the filtered result updates when comments change
  const filteredComments = useMemo(() => {
    if (!ctx || !review_id) {
      return [];
    }
    const comments = [...fileComments, ...submissionComments];
    return comments.filter((c) => c.submission_review_id === review_id);
  }, [ctx, fileComments, submissionComments, review_id]);

  return filteredComments;
}
export function useAllCommentsForReview(review_id: number | undefined) {
  const ctx = useContext(SubmissionContext);
  const fileComments = useSubmissionFileComments({});
  const submissionComments = useSubmissionComments({});
  const artifactComments = useSubmissionArtifactComments({});

  // Use useMemo to ensure the filtered result updates when comments change
  const filteredComments = useMemo(() => {
    if (!ctx || !review_id) {
      return [];
    }
    const comments = [...fileComments, ...submissionComments, ...artifactComments];
    const filtered = comments.filter((c) => c.submission_review_id === review_id);

    return filtered;
  }, [ctx, fileComments, submissionComments, artifactComments, review_id]);
  return filteredComments;
}
export function useRubricCheckInstances(
  check: RubricChecks,
  review_id: number | undefined,
  target_student_profile_id?: string | null
) {
  const ctx = useContext(SubmissionContext);
  const fileComments = useSubmissionFileComments({});
  const submissionComments = useSubmissionComments({});
  const artifactComments = useSubmissionArtifactComments({});

  const filteredComments = useMemo(() => {
    if (!ctx || !review_id) {
      return [];
    }
    const comments = [...fileComments, ...submissionComments, ...artifactComments];
    let filtered = comments.filter((c) => check.id === c.rubric_check_id && c.submission_review_id === review_id);
    if (target_student_profile_id != null) {
      filtered = filtered.filter(
        (c) =>
          (c as { target_student_profile_id?: string | null }).target_student_profile_id === target_student_profile_id
      );
    }
    return filtered;
  }, [ctx, fileComments, submissionComments, artifactComments, check.id, review_id, target_student_profile_id]);

  return filteredComments;
}

export function useRubricCriteriaInstances({
  criteria,
  review_id,
  rubric_id,
  target_student_profile_id
}: {
  criteria?: RubricCriteria;
  review_id?: number;
  rubric_id?: number;
  target_student_profile_id?: string | null;
}) {
  const fileComments = useSubmissionFileComments({});
  const submissionComments = useSubmissionComments({});
  const artifactComments = useSubmissionArtifactComments({});
  const { data: allChecks = [] } = useRubricChecksQuery();

  const filteredComments = useMemo(() => {
    if (!review_id) {
      return [];
    }
    const comments = [...fileComments, ...submissionComments, ...artifactComments];
    let filtered: typeof comments;
    if (criteria) {
      filtered = comments.filter(
        (eachComment) =>
          eachComment.submission_review_id === review_id &&
          allChecks.find(
            (eachCheck) => eachCheck.rubric_criteria_id === criteria?.id && eachCheck.id === eachComment.rubric_check_id
          )
      );
    } else if (rubric_id) {
      filtered = comments.filter(
        (eachComment) =>
          eachComment.submission_review_id === review_id &&
          allChecks.find(
            (eachCheck) => eachCheck.id === eachComment.rubric_check_id && eachCheck.rubric_id === rubric_id
          )
      );
    } else {
      throw new Error("Either criteria or rubric_id must be provided");
    }
    if (target_student_profile_id != null) {
      filtered = filtered.filter(
        (c) =>
          (c as { target_student_profile_id?: string | null }).target_student_profile_id === target_student_profile_id
      );
    }
    return filtered;
  }, [
    fileComments,
    submissionComments,
    artifactComments,
    review_id,
    criteria,
    rubric_id,
    allChecks,
    target_student_profile_id
  ]);

  return filteredComments;
}

export function useSubmissionReview(reviewId?: number) {
  const { data = [] } = useSubmissionReviewsQuery();
  return useMemo(() => (reviewId ? data.find((r) => r.id === reviewId) : undefined), [data, reviewId]);
}
export function useSubmissionReviews() {
  const { data } = useSubmissionReviewsQuery();
  return data;
}

export function useSubmissionReviewOrGradingReview(reviewId: number | undefined) {
  const { data = [] } = useSubmissionReviewsQuery();
  return useMemo(() => (reviewId ? data.find((r) => r.id === reviewId) : undefined), [data, reviewId]);
}
export function useRubricCheck(rubric_check_id: number | null) {
  const { data: allChecks = [] } = useRubricChecksQuery();
  const { data: allCriteria = [] } = useRubricCriteriaQuery();
  const check = useMemo(() => allChecks.find((c) => c.id === rubric_check_id), [allChecks, rubric_check_id]);
  const criteria = useMemo(
    () => allCriteria.find((c) => c.id === check?.rubric_criteria_id),
    [allCriteria, check?.rubric_criteria_id]
  );
  return {
    rubricCheck: check,
    rubricCriteria: criteria
  };
}

export function useSubmissionFile() {
  const controller = useSubmissionController();
  return controller.file;
}

export function useSubmissionController(): SubmissionController {
  const ctx = useContext(SubmissionContext);
  if (!ctx) {
    throw new Error("SubmissionContext not found");
  }
  return ctx.submissionController;
}

export type ReviewAssignmentWithDetails = Database["public"]["Tables"]["review_assignments"]["Row"] & {
  rubrics?: Database["public"]["Tables"]["rubrics"]["Row"] & {
    rubric_parts?: HydratedRubricPart[];
  };
  review_assignment_rubric_parts?: (Database["public"]["Tables"]["review_assignment_rubric_parts"]["Row"] & {
    rubric_parts?: HydratedRubricPart;
  })[];
  profiles?: Database["public"]["Tables"]["profiles"]["Row"];
};

export type ReferencedRubricCheckInstance = {
  referencedRubricCheck: Tables<"rubric_checks">;
  comment: (
    | Tables<"submission_file_comments">
    | Tables<"submission_comments">
    | Tables<"submission_artifact_comments">
  ) & {
    type: "file" | "general" | "artifact";
    author_profile?: Partial<Tables<"profiles">> | null;
  };
  submissionReview?: Tables<"submission_reviews">;
  rubric?: Pick<Tables<"rubrics">, "id" | "name" | "review_round" | "assignment_id">;
  reviewRound?: Enums<"review_round"> | null;
  authorProfile?: Partial<Tables<"profiles">> | null;
};

export function useReferencedRubricCheckInstances(referencing_check_id: number | undefined | null) {
  // Get comments from submission controller instead of separate queries
  const fileComments = useSubmissionFileComments({});
  const submissionComments = useSubmissionComments({});
  const artifactComments = useSubmissionArtifactComments({});

  const referencingCheckReferences = useReferencingRubricChecks(referencing_check_id);

  const allRelevantComments = useMemo(() => {
    const referencedCheckIds = referencingCheckReferences?.map((ref) => ref.referenced_rubric_check_id);
    const relevantFileComments = fileComments.filter(
      (comment) =>
        comment.rubric_check_id && referencedCheckIds?.includes(comment.rubric_check_id) && comment.deleted_at === null
    );
    const relevantSubmissionComments = submissionComments.filter(
      (comment) =>
        comment.rubric_check_id && referencedCheckIds?.includes(comment.rubric_check_id) && comment.deleted_at === null
    );
    const relevantArtifactComments = artifactComments.filter(
      (comment) =>
        comment.rubric_check_id && referencedCheckIds?.includes(comment.rubric_check_id) && comment.deleted_at === null
    );
    return [...relevantFileComments, ...relevantSubmissionComments, ...relevantArtifactComments];
  }, [fileComments, submissionComments, artifactComments, referencingCheckReferences]);

  return allRelevantComments;
}

export function useSubmissionReviewForRubric(rubricId?: number | null): SubmissionReview | undefined {
  const submission = useSubmissionMaybe();
  const reviews = useSubmissionReviews();

  return useMemo(() => {
    if (!rubricId || !submission) {
      return undefined;
    }
    return reviews?.find((review) => review.submission_id === submission.id && review.rubric_id === rubricId);
  }, [rubricId, submission, reviews]);
}
export function useWritableReferencingRubricChecks(rubric_check_id: number | null | undefined) {
  const referencingChecks = useReferencingRubricChecks(rubric_check_id);

  const writableSubmissionReviews = useWritableSubmissionReviews();
  return useMemo(() => {
    if (!referencingChecks || !writableSubmissionReviews) {
      return undefined;
    }
    return referencingChecks.filter((rc) => writableSubmissionReviews?.some((sr) => sr.rubric_id === rc.rubric_id));
  }, [referencingChecks, writableSubmissionReviews]);
}

export function useWritableSubmissionReviews(rubric_id?: number) {
  const submission = useSubmissionMaybe();
  const id = submission?.id;
  const submissionReviews = useSubmissionReviews();
  const { data: rubrics = [] } = useRubricsQuery();
  const { data: allMyReviewAssignments = [] } = useReviewAssignmentsQuery();
  const assignments = useMemo(
    () => allMyReviewAssignments.filter((a) => a.submission_id === id),
    [allMyReviewAssignments, id]
  );

  const { role } = useClassProfiles();
  const memoizedReviews = useMemo(() => {
    const writableRubrics: Rubric[] = [];
    if (role.role === "instructor") {
      writableRubrics.push(...rubrics);
    }
    if (role.role === "grader") {
      writableRubrics.push(
        ...rubrics.filter(
          (r) =>
            r.review_round === "grading-review" ||
            r.review_round === "code-walk" ||
            assignments.some((a) => a.rubric_id === r.id)
        )
      );
    }
    if (role.role === "student") {
      writableRubrics.push(
        ...rubrics.filter((r) => r.review_round === "self-review" || assignments.some((a) => a.rubric_id === r.id))
      );
    }
    const ret = submissionReviews?.filter(
      (sr) =>
        writableRubrics.some((r) => r.id === sr.rubric_id) &&
        (rubric_id === undefined || sr.rubric_id === rubric_id) &&
        (role.role === "instructor" || role.role == "grader" || !sr.completed_at)
    );
    //Make sure no duplicates by review id
    const uniqueReviews = ret?.filter((sr, index, self) => index === self.findIndex((t) => t.id === sr.id));
    // Sort by name
    uniqueReviews?.sort((a, b) => a.name.localeCompare(b.name));
    return uniqueReviews;
  }, [role, rubrics, submissionReviews, assignments, rubric_id]);
  return memoizedReviews;
}
