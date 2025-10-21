"use client";
import { toaster } from "@/components/ui/toaster";
import {
  useAllRubricChecks,
  useRubricCheck as useAssignmentUseRubricCheck,
  useRubricCriteria as useAssignmentUseRubricCriteria,
  useMyReviewAssignments,
  useReferencingRubricChecks,
  useRubrics
} from "@/hooks/useAssignment";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useCourseController } from "@/hooks/useCourseController";
import { ClassRealTimeController } from "@/lib/ClassRealTimeController";
import TableController, { PossiblyTentativeResult } from "@/lib/TableController";
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
import { useParams } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { SubmissionReviewProvider } from "./useSubmissionReview";

class SubmissionController {
  private _submission?: SubmissionWithGraderResultsAndFiles;
  private _file?: SubmissionFile;
  private _artifact?: SubmissionArtifact;

  readonly submission_comments: TableController<"submission_comments">;
  readonly submission_file_comments: TableController<"submission_file_comments">;
  readonly submission_artifact_comments: TableController<"submission_artifact_comments">;
  readonly submission_reviews: TableController<"submission_reviews">;
  readonly submission_regrade_request_comments: TableController<"submission_regrade_request_comments">;

  readonly readyPromise: Promise<[void, void, void, void, void]>;

  constructor(
    client: SupabaseClient<Database>,
    submission_id: number,
    class_id: number,
    classRealTimeController: ClassRealTimeController
  ) {
    this.submission_comments = new TableController({
      client,
      table: "submission_comments",
      query: client.from("submission_comments").select("*").eq("submission_id", submission_id),
      classRealTimeController,
      submissionId: submission_id
    });
    this.submission_file_comments = new TableController({
      client,
      table: "submission_file_comments",
      query: client.from("submission_file_comments").select("*").eq("submission_id", submission_id),
      classRealTimeController,
      submissionId: submission_id
    });
    this.submission_artifact_comments = new TableController({
      client,
      table: "submission_artifact_comments",
      query: client.from("submission_artifact_comments").select("*").eq("submission_id", submission_id),
      classRealTimeController,
      submissionId: submission_id
    });
    this.submission_reviews = new TableController({
      client,
      table: "submission_reviews",
      query: client.from("submission_reviews").select("*").eq("submission_id", submission_id),
      classRealTimeController,
      submissionId: submission_id
    });
    this.submission_regrade_request_comments = new TableController({
      client,
      table: "submission_regrade_request_comments",
      query: client.from("submission_regrade_request_comments").select("*").eq("submission_id", submission_id),
      classRealTimeController,
      submissionId: submission_id
    });
    this.readyPromise = Promise.all([
      this.submission_comments.readyPromise,
      this.submission_file_comments.readyPromise,
      this.submission_artifact_comments.readyPromise,
      this.submission_reviews.readyPromise,
      this.submission_regrade_request_comments.readyPromise
    ]);
  }

  close() {
    this.submission_comments.close();
    this.submission_file_comments.close();
    this.submission_artifact_comments.close();
    this.submission_reviews.close();
    this.submission_regrade_request_comments.close();
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
  const class_id = Number(params.course_id);
  const controller = useRef<SubmissionController | null>(null);
  const [ready, setReady] = useState(false);
  const [newControllersReady, setNewControllersReady] = useState(false);
  const [isLoadingNewController, setIsLoadingNewController] = useState(false);
  const courseController = useCourseController();

  if (controller.current === null) {
    controller.current = new SubmissionController(
      createClient(),
      submission_id,
      class_id,
      courseController.classRealTimeController
    );
    setIsLoadingNewController(true);
    setNewControllersReady(false);
  }
  useEffect(() => {
    return () => {
      if (controller.current) {
        controller.current.close();
        controller.current = null;
      }
    };
  }, []);
  useEffect(() => {
    if (controller.current && isLoadingNewController) {
      setIsLoadingNewController(false);
      controller.current.readyPromise.then(() => {
        setNewControllersReady(true);
      });
    }
  }, [controller, isLoadingNewController]);

  if (isNaN(submission_id)) {
    toaster.error({
      title: "Invalid Submission ID",
      description: "Submission ID is not a valid number after checking params."
    });
    return <Text>Error: Invalid Submission ID.</Text>;
  }

  return (
    <SubmissionContext.Provider value={{ submissionController: controller.current }}>
      <SubmissionControllerCreator submission_id={submission_id} setReady={setReady} />
      {(!ready || !newControllersReady) && <Spinner />}
      {ready && newControllersReady && <SubmissionReviewProvider>{children}</SubmissionReviewProvider>}
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
  const [comments, setComments] = useState<SubmissionFileComment[]>([]);
  const ctx = useContext(SubmissionContext);
  const submissionController = ctx?.submissionController;

  useEffect(() => {
    if (!submissionController) {
      setComments([]);
      return;
    }
    const { unsubscribe, data } = submissionController.submission_file_comments.list((data, { entered, left }) => {
      setComments(
        data.filter(
          (comment) =>
            (comment.deleted_at === null || comment.deleted_at === undefined) &&
            (file_id === undefined || comment.submission_file_id === file_id)
        )
      );
      if (onEnter) {
        onEnter(
          entered.filter(
            (comment) =>
              (comment.deleted_at === null || comment.deleted_at === undefined) &&
              (file_id === undefined || comment.submission_file_id === file_id)
          )
        );
      }
      if (onLeave) {
        onLeave(
          left.filter(
            (comment) =>
              (comment.deleted_at === null || comment.deleted_at === undefined) &&
              (file_id === undefined || comment.submission_file_id === file_id)
          )
        );
      }
    });
    const filteredData = data.filter(
      (comment) =>
        (comment.deleted_at === null || comment.deleted_at === undefined) &&
        (file_id === undefined || comment.submission_file_id === file_id)
    );
    setComments(filteredData);
    if (onEnter) {
      onEnter(filteredData);
    }
    return () => unsubscribe();
  }, [submissionController, file_id, onEnter, onLeave]);

  if (!submissionController) {
    return [];
  }
  return comments;
}

export function useSubmissionComments({
  onEnter,
  onLeave
}: {
  onEnter?: (comment: SubmissionComments[]) => void;
  onLeave?: (comment: SubmissionComments[]) => void;
}) {
  const [comments, setComments] = useState<SubmissionComments[]>([]);
  const ctx = useContext(SubmissionContext);
  const submissionController = ctx?.submissionController;

  useEffect(() => {
    if (!submissionController) {
      setComments([]);
      return;
    }
    const { unsubscribe, data } = submissionController.submission_comments.list((data, { entered, left }) => {
      const filteredData = data.filter((comment) => comment.deleted_at === null || comment.deleted_at === undefined);
      setComments(filteredData);
      if (onEnter) {
        onEnter(entered.filter((comment) => comment.deleted_at === null || comment.deleted_at === undefined));
      }
      if (onLeave) {
        onLeave(left.filter((comment) => comment.deleted_at === null || comment.deleted_at === undefined));
      }
    });
    const filteredData = data.filter((comment) => comment.deleted_at === null || comment.deleted_at === undefined);
    setComments(filteredData);
    if (onEnter) {
      onEnter(filteredData);
    }
    return () => unsubscribe();
  }, [submissionController, onEnter, onLeave]);

  if (!submissionController) {
    return [];
  }
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
  const [comments, setComments] = useState<SubmissionArtifactComment[]>([]);
  const ctx = useContext(SubmissionContext);
  const submissionController = ctx?.submissionController;

  useEffect(() => {
    if (!submissionController) {
      setComments([]);
      return;
    }
    const { unsubscribe, data } = submissionController.submission_artifact_comments.list((data, { entered, left }) => {
      setComments(data.filter((comment) => comment.deleted_at === null));
      if (onEnter) {
        onEnter(entered.filter((comment) => comment.deleted_at === null));
      }
      if (onLeave) {
        onLeave(left.filter((comment) => comment.deleted_at === null));
      }
    });
    const filteredData = data.filter((comment) => comment.deleted_at === null);
    setComments(filteredData);
    if (onEnter) {
      onEnter(filteredData);
    }
    return () => unsubscribe();
  }, [submissionController, onEnter, onLeave]);

  if (!submissionController) {
    return [];
  }
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
  const [comments, setComments] = useState<RegradeRequestComment[]>([]);
  const ctx = useContext(SubmissionContext);
  const submissionController = ctx?.submissionController;

  useEffect(() => {
    if (!submissionController) {
      setComments([]);
      return;
    }
    const { unsubscribe, data } = submissionController.submission_regrade_request_comments.list(
      (data, { entered, left }) => {
        const filteredData = data.filter(
          (comment) =>
            submission_regrade_request_id === undefined ||
            comment.submission_regrade_request_id === submission_regrade_request_id
        );
        setComments(filteredData);
        if (onEnter) {
          onEnter(
            entered.filter(
              (comment) =>
                submission_regrade_request_id === undefined ||
                comment.submission_regrade_request_id === submission_regrade_request_id
            )
          );
        }
        if (onLeave) {
          onLeave(
            left.filter(
              (comment) =>
                submission_regrade_request_id === undefined ||
                comment.submission_regrade_request_id === submission_regrade_request_id
            )
          );
        }
      }
    );
    setComments(
      data.filter(
        (comment) =>
          submission_regrade_request_id === undefined ||
          comment.submission_regrade_request_id === submission_regrade_request_id
      )
    );
    if (onEnter) {
      onEnter(
        data.filter(
          (comment) =>
            submission_regrade_request_id === undefined ||
            comment.submission_regrade_request_id === submission_regrade_request_id
        )
      );
    }
    return () => unsubscribe();
  }, [submissionController, submission_regrade_request_id, onEnter, onLeave]);

  if (!submissionController) {
    return [];
  }
  return comments;
}

/**
 * Returns a reactive submission file comment by its ID, updating as the comment changes in real time.
 *
 * @param comment_id - The ID of the submission file comment to subscribe to
 * @returns The submission file comment object, or undefined if not found
 */
export function useSubmissionFileComment(comment_id: number) {
  const submissionController = useSubmissionController();
  const [comment, setComment] = useState<SubmissionFileComment | undefined>(
    submissionController.submission_file_comments.getById(comment_id).data
  );
  useEffect(() => {
    const { unsubscribe, data } = submissionController.submission_file_comments.getById(comment_id, (data) => {
      setComment(data);
    });
    setComment(data);
    return () => unsubscribe();
  }, [submissionController, comment_id]);
  return comment;
}
export function useSubmissionArtifactComment(comment_id: number) {
  const submissionController = useSubmissionController();
  const [comment, setComment] = useState<SubmissionArtifactComment | undefined>(
    submissionController.submission_artifact_comments.getById(comment_id).data
  );
  useEffect(() => {
    const { unsubscribe, data } = submissionController.submission_artifact_comments.getById(comment_id, (data) => {
      setComment(data);
    });
    setComment(data);
    return () => unsubscribe();
  }, [submissionController, comment_id]);
  return comment;
}
export function useSubmissionComment(comment_id: number) {
  const submissionController = useSubmissionController();
  const [comment, setComment] = useState<SubmissionComments | undefined>(
    submissionController.submission_comments.getById(comment_id).data
  );
  useEffect(() => {
    const { unsubscribe, data } = submissionController.submission_comments.getById(comment_id, (data) => {
      setComment(data);
    });
    setComment(data);
    return () => unsubscribe();
  }, [submissionController, comment_id]);
  return comment;
}
export function useSubmissionCommentByType(comment_id: number, type: "file" | "artifact" | "submission") {
  const ctx = useContext(SubmissionContext);
  const [comment, setComment] = useState<
    PossiblyTentativeResult<SubmissionFileComment | SubmissionArtifactComment | SubmissionComments> | undefined
  >(undefined);
  if (!ctx) {
    throw new Error("SubmissionContext not found");
  }
  const submissionController = ctx.submissionController;
  useEffect(() => {
    if (type === "file") {
      const { unsubscribe, data } = submissionController.submission_file_comments.getById(comment_id, (data) => {
        setComment(data);
      });
      setComment(data);
      return () => unsubscribe();
    }
    if (type === "artifact") {
      const { unsubscribe, data } = submissionController.submission_artifact_comments.getById(comment_id, (data) => {
        setComment(data);
      });
      setComment(data);
      return () => unsubscribe();
    }
    if (type === "submission") {
      const { unsubscribe, data } = submissionController.submission_comments.getById(comment_id, (data) => {
        setComment(data);
      });
      setComment(data);
      return () => unsubscribe();
    }
  }, [submissionController, comment_id, type]);
  return comment;
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
        grader_results(*, grader_result_tests(*), grader_result_output(*)),
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
export function useRubricCheckInstances(check: RubricChecks, review_id: number | undefined) {
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
    const filtered = comments.filter((c) => check.id === c.rubric_check_id && c.submission_review_id === review_id);

    return filtered;
  }, [ctx, fileComments, submissionComments, artifactComments, check.id, review_id]);

  return filteredComments;
}

export function useRubricCriteriaInstances({
  criteria,
  review_id,
  rubric_id
}: {
  criteria?: RubricCriteria;
  review_id?: number;
  rubric_id?: number;
}) {
  const fileComments = useSubmissionFileComments({});
  const submissionComments = useSubmissionComments({});
  const allChecks = useAllRubricChecks();

  // Use useMemo to ensure the filtered result updates when comments change
  const filteredComments = useMemo(() => {
    if (!review_id) {
      return [];
    }
    const comments = [...fileComments, ...submissionComments];
    if (criteria) {
      return comments.filter(
        (eachComment) =>
          eachComment.submission_review_id === review_id &&
          allChecks.find(
            (eachCheck) => eachCheck.rubric_criteria_id === criteria?.id && eachCheck.id === eachComment.rubric_check_id
          )
      );
    }
    if (rubric_id) {
      return comments.filter(
        (eachComment) =>
          eachComment.submission_review_id === review_id &&
          allChecks.find(
            (eachCheck) => eachCheck.id === eachComment.rubric_check_id && eachCheck.rubric_id === rubric_id
          )
      );
    }
    throw new Error("Either criteria or rubric_id must be provided");
  }, [fileComments, submissionComments, review_id, criteria, rubric_id, allChecks]);

  return filteredComments;
}

export function useSubmissionReview(reviewId?: number) {
  const ctx = useContext(SubmissionContext);
  const controller = useSubmissionController();
  const [review, setReview] = useState<SubmissionReview | undefined>(undefined);
  useEffect(() => {
    if (!ctx || !controller || !reviewId) {
      return;
    }
    const { unsubscribe, data } = controller.submission_reviews.getById(reviewId, (data) => {
      setReview(data);
    });
    setReview(data);
    return () => unsubscribe();
  }, [ctx, controller, reviewId]);
  return review;
}
export function useSubmissionReviews() {
  const ctx = useContext(SubmissionContext);
  const controller = ctx?.submissionController;
  const [reviews, setReviews] = useState<SubmissionReview[] | undefined>(controller?.submission_reviews.rows);
  useEffect(() => {
    if (!ctx || !controller) {
      return;
    }
    const { unsubscribe, data } = controller.submission_reviews.list((data) => {
      setReviews(data);
    });
    setReviews(data);
    return () => unsubscribe();
  }, [ctx, controller, controller?.submission_reviews]);
  return reviews;
}

export function useSubmissionReviewOrGradingReview(reviewId: number | undefined) {
  const ctx = useContext(SubmissionContext);
  const controller = useSubmissionController();
  if (!ctx || !controller) {
    throw new Error("useSubmissionReviewOrGradingReview must be used within a SubmissionContext");
  }
  const [review, setReview] = useState<SubmissionReview | undefined>(() => {
    if (!reviewId) {
      return undefined;
    }
    return controller.submission_reviews.getById(reviewId).data;
  });
  useEffect(() => {
    if (!reviewId) {
      setReview(undefined);
      return;
    }
    const { unsubscribe, data } = controller.submission_reviews.getById(reviewId, (data) => {
      setReview(data);
    });
    setReview(data);
    return () => {
      unsubscribe();
    };
  }, [ctx, controller, reviewId]);

  return review;
}
export function useRubricCheck(rubric_check_id: number | null) {
  const check = useAssignmentUseRubricCheck(rubric_check_id);
  const criteria = useAssignmentUseRubricCriteria(check?.rubric_criteria_id);
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
  const ctx = useContext(SubmissionContext);
  const controller = ctx?.submissionController;
  const submission = controller?.submission;
  const reviews = useSubmissionReviews();

  const [submissionReview, setSubmissionReview] = useState<SubmissionReview | undefined>(undefined);

  useEffect(() => {
    if (!rubricId || !submission || !controller) {
      setSubmissionReview(undefined);
      return;
    }
    const desiredReview = reviews?.find(
      (review) => review.submission_id === submission.id && review.rubric_id === rubricId
    );
    if (desiredReview) {
      setSubmissionReview(desiredReview);
      const { unsubscribe } = controller.submission_reviews.getById(desiredReview.id, (updatedReview) => {
        setSubmissionReview(updatedReview);
      });
      return () => unsubscribe();
    }
  }, [rubricId, submission, controller, reviews]);

  return submissionReview;
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
  const id = useSubmissionController().submission.id;
  const submissionReviews = useSubmissionReviews();
  const rubrics = useRubrics();
  const assignments = useMyReviewAssignments(id);

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
