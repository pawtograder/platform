"use client";
import { toaster } from "@/components/ui/toaster";
import {
  HydratedRubricPart,
  RubricChecks,
  RubricCriteriaWithRubricChecks,
  SubmissionArtifact,
  SubmissionArtifactComment,
  SubmissionComments,
  SubmissionFile,
  SubmissionFileComment,
  SubmissionReview,
  SubmissionReviewWithRubric,
  SubmissionWithFilesGraderResultsOutputTestsAndRubric,
  HydratedRubricCriteria,
  HydratedRubricCheck
} from "@/utils/supabase/DatabaseTypes";
import { Spinner, Text } from "@chakra-ui/react";
import { LiveEvent, useList, useShow } from "@refinedev/core";
import { useParams } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Unsubscribe } from "./useCourseController";
import { Database, Enums, Tables } from "@/utils/supabase/SupabaseTypes";
import { useSupabaseClient } from "@supabase/auth-helpers-react";
import { PostgrestError } from "@supabase/supabase-js";

type ListUpdateCallback<T> = (
  data: T[],
  {
    entered,
    left,
    updated
  }: {
    entered: T[];
    left: T[];
    updated: T[];
  }
) => void;
type ItemUpdateCallback<T> = (data: T) => void;

class SubmissionController {
  private _submission?: SubmissionWithFilesGraderResultsOutputTestsAndRubric;
  private _file?: SubmissionFile;
  private _artifact?: SubmissionArtifact;

  private genericDataSubscribers: { [key in string]: Map<number, ItemUpdateCallback<unknown>[]> } = {};
  private genericData: { [key in string]: Map<number, unknown> } = {};
  private genericDataListSubscribers: { [key in string]: ListUpdateCallback<unknown>[] } = {};

  private genericDataTypeToId: { [key in string]: (item: unknown) => number } = {};

  registerGenericDataType(typeName: string, idGetter: (item: unknown) => number) {
    if (!this.genericDataTypeToId[typeName]) {
      this.genericDataTypeToId[typeName] = idGetter;
      this.genericDataSubscribers[typeName] = new Map();
      this.genericDataListSubscribers[typeName] = [];
    }
  }

  setGeneric(typeName: string, data: unknown[]) {
    if (!this.genericData[typeName]) {
      this.genericData[typeName] = new Map();
    }
    const idGetter = this.genericDataTypeToId[typeName];
    for (const item of data) {
      const id = idGetter(item);
      this.genericData[typeName].set(id, item);
      const itemSubscribers = this.genericDataSubscribers[typeName]?.get(id) || [];
      itemSubscribers.forEach((cb) => cb(item));
    }
    const listSubscribers = this.genericDataListSubscribers[typeName] || [];
    // TODO is this over-called?
    listSubscribers.forEach((cb) =>
      cb(Array.from(this.genericData[typeName].values()), { entered: data as unknown[], left: [], updated: [] })
    );
  }
  listGenericData<T>(
    typeName: string,
    callback?: ListUpdateCallback<T>,
    filter?: (item: T) => boolean
  ): { unsubscribe: Unsubscribe; data: T[] } {
    const subscribers = this.genericDataListSubscribers[typeName] || [];
    let filteredCallback = callback as ListUpdateCallback<unknown> | undefined;
    if (filteredCallback && callback) {
      if (filter) {
        filteredCallback = (data, { entered, left, updated }) => {
          data = data.filter(filter as (value: unknown) => boolean); // Added assertion for filter
          (callback as ListUpdateCallback<unknown>)(data, { entered, left, updated });
        };
      }
      subscribers.push(filteredCallback);
    }
    this.genericDataListSubscribers[typeName] = subscribers;
    const currentData = this.genericData[typeName]?.values() || [];
    if (filter) {
      return {
        unsubscribe: () => {
          this.genericDataListSubscribers[typeName] =
            this.genericDataListSubscribers[typeName]?.filter((cb) => cb !== callback) || [];
        },
        data: (Array.from(currentData) as T[]).filter(filter)
      };
    }
    return {
      unsubscribe: () => {
        this.genericDataListSubscribers[typeName] =
          this.genericDataListSubscribers[typeName]?.filter((cb) => cb !== callback) || [];
      },
      data: Array.from(currentData) as T[]
    };
  }
  getValueWithSubscription<T>(
    typeName: string,
    id: number | ((item: T) => boolean),
    callback?: ItemUpdateCallback<T>
  ): { unsubscribe: Unsubscribe; data: T | undefined } {
    if (!this.genericDataTypeToId[typeName]) {
      throw new Error(`No id getter for type ${typeName}`);
    }
    if (typeof id === "function") {
      const idPredicate = id as (item: unknown) => boolean; // Assertion for id function
      const relevantIds = Array.from(this.genericData[typeName]?.keys() || []).filter((_id) => {
        const item = this.genericData[typeName]?.get(_id);
        return item !== undefined && idPredicate(item);
      });
      if (relevantIds.length == 0) {
        return {
          unsubscribe: () => {},
          data: undefined
        };
      } else if (relevantIds.length == 1) {
        const foundId = relevantIds[0];
        const subscribers = this.genericDataSubscribers[typeName]?.get(foundId) || [];
        if (callback) {
          this.genericDataSubscribers[typeName]?.set(foundId, [
            ...subscribers,
            callback as ItemUpdateCallback<unknown>
          ]);
        }
        return {
          unsubscribe: () => {
            this.genericDataSubscribers[typeName]?.set(
              foundId,
              subscribers.filter((cb) => cb !== callback)
            );
          },
          data: this.genericData[typeName]?.get(foundId) as T | undefined
        };
      } else {
        throw new Error(`Multiple ids found for type ${typeName}`);
      }
    } else if (typeof id === "number") {
      const subscribers = this.genericDataSubscribers[typeName]?.get(id) || [];
      if (callback) {
        this.genericDataSubscribers[typeName]?.set(id, [...subscribers, callback as ItemUpdateCallback<unknown>]);
      }
      return {
        unsubscribe: () => {
          this.genericDataSubscribers[typeName]?.set(
            id,
            subscribers.filter((cb) => cb !== callback)
          );
        },
        data: this.genericData[typeName]?.get(id) as T | undefined
      };
    } else {
      throw new Error(`Invalid id type ${typeof id}`);
    }
  }
  handleGenericDataEvent(typeName: string, event: LiveEvent) {
    const body = event.payload as unknown; // Assertion for event.payload
    const idGetter = this.genericDataTypeToId[typeName];
    const id = idGetter(body);
    if (event.type === "created") {
      this.genericData[typeName].set(id, body);
      this.genericDataSubscribers[typeName]?.get(id)?.forEach((cb) => cb(body));
      this.genericDataListSubscribers[typeName]?.forEach((cb) =>
        cb(Array.from(this.genericData[typeName].values()), { entered: [body], left: [], updated: [] })
      );
    } else if (event.type === "updated") {
      this.genericData[typeName].set(id, body);
      this.genericDataSubscribers[typeName]?.get(id)?.forEach((cb) => cb(body));
      this.genericDataListSubscribers[typeName]?.forEach((cb) =>
        cb(Array.from(this.genericData[typeName].values()), { entered: [], left: [], updated: [body] })
      );
    } else if (event.type === "deleted") {
      this.genericData[typeName].delete(id);
      this.genericDataSubscribers[typeName]?.get(id)?.forEach((cb) => cb(undefined));
      this.genericDataListSubscribers[typeName]?.forEach((cb) =>
        cb(Array.from(this.genericData[typeName].values()), { entered: [], left: [body], updated: [] })
      );
    }
  }
  constructor() {}

  get isReady() {
    return this._submission !== undefined;
  }

  set submission(submission: SubmissionWithFilesGraderResultsOutputTestsAndRubric) {
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
  const controller = useRef<SubmissionController>(new SubmissionController());
  const [ready, setReady] = useState(false);

  const submission_id = initial_submission_id ?? Number(params.submissions_id);

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
      {ready && children}
    </SubmissionContext.Provider>
  );
}
export function useSubmissionFileComments({
  file_id,
  onEnter,
  onLeave,
  onUpdate
}: {
  file_id?: number;
  onEnter?: (comment: SubmissionFileComment[]) => void;
  onLeave?: (comment: SubmissionFileComment[]) => void;
  onUpdate?: (comment: SubmissionFileComment[]) => void;
}) {
  const [comments, setComments] = useState<SubmissionFileComment[]>([]);
  const ctx = useContext(SubmissionContext);
  const submissionController = ctx?.submissionController;

  useEffect(() => {
    if (!submissionController) {
      setComments([]);
      return;
    }
    const { unsubscribe, data } = submissionController.listGenericData<SubmissionFileComment>(
      "submission_file_comments",
      (data, { entered, left, updated }) => {
        setComments(data.filter((comment) => comment.deleted_at === null));
        if (onEnter) {
          onEnter(entered.filter((comment) => comment.deleted_at === null));
        }
        if (onLeave) {
          onLeave(left.filter((comment) => comment.deleted_at === null));
        }
        if (onUpdate) {
          onUpdate(updated.filter((comment) => comment.deleted_at === null));
        }
      },
      (item) => file_id === undefined || item.submission_file_id === file_id
    );
    setComments(data.filter((comment) => comment.deleted_at === null));
    if (onEnter) {
      onEnter(data.filter((comment) => comment.deleted_at === null));
    }
    return () => unsubscribe();
  }, [submissionController, file_id, onEnter, onLeave, onUpdate]);

  if (!submissionController) {
    return [];
  }
  return comments;
}

export function useSubmissionComments({
  onEnter,
  onLeave,
  onUpdate
}: {
  onEnter?: (comment: SubmissionComments[]) => void;
  onLeave?: (comment: SubmissionComments[]) => void;
  onUpdate?: (comment: SubmissionComments[]) => void;
}) {
  const [comments, setComments] = useState<SubmissionComments[]>([]);
  const ctx = useContext(SubmissionContext);
  const submissionController = ctx?.submissionController;

  useEffect(() => {
    if (!submissionController) {
      setComments([]);
      return;
    }
    const { unsubscribe, data } = submissionController.listGenericData<SubmissionComments>(
      "submission_comments",
      (data, { entered, left, updated }) => {
        setComments(data.filter((comment) => comment.deleted_at === null));
        if (onEnter) {
          onEnter(entered.filter((comment) => comment.deleted_at === null));
        }
        if (onLeave) {
          onLeave(left.filter((comment) => comment.deleted_at === null));
        }
        if (onUpdate) {
          onUpdate(updated.filter((comment) => comment.deleted_at === null));
        }
      }
    );
    setComments(data.filter((comment) => comment.deleted_at === null));
    if (onEnter) {
      onEnter(data.filter((comment) => comment.deleted_at === null));
    }
    return () => unsubscribe();
  }, [submissionController, onEnter, onLeave, onUpdate]);

  if (!submissionController) {
    return [];
  }
  return comments;
}

export function useSubmissionArtifactComments({
  onEnter,
  onLeave,
  onUpdate
}: {
  onEnter?: (comment: SubmissionArtifactComment[]) => void;
  onLeave?: (comment: SubmissionArtifactComment[]) => void;
  onUpdate?: (comment: SubmissionArtifactComment[]) => void;
}) {
  const [comments, setComments] = useState<SubmissionArtifactComment[]>([]);
  const ctx = useContext(SubmissionContext);
  const submissionController = ctx?.submissionController;

  useEffect(() => {
    if (!submissionController) {
      setComments([]);
      return;
    }
    const { unsubscribe, data } = submissionController.listGenericData<SubmissionArtifactComment>(
      "submission_artifact_comments",
      (data, { entered, left, updated }) => {
        setComments(data.filter((comment) => comment.deleted_at === null));
        if (onEnter) {
          onEnter(entered.filter((comment) => comment.deleted_at === null));
        }
        if (onLeave) {
          onLeave(left.filter((comment) => comment.deleted_at === null));
        }
        if (onUpdate) {
          onUpdate(updated.filter((comment) => comment.deleted_at === null));
        }
      }
    );
    setComments(data.filter((comment) => comment.deleted_at === null));
    if (onEnter) {
      onEnter(data.filter((comment) => comment.deleted_at === null));
    }
    return () => unsubscribe();
  }, [submissionController, onEnter, onLeave, onUpdate]);

  if (!submissionController) {
    return [];
  }
  return comments;
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
  const { query } = useShow<SubmissionWithFilesGraderResultsOutputTestsAndRubric>({
    resource: "submissions",
    id: submission_id,
    meta: {
      select:
        "*, assignments(*, rubrics(*,rubric_criteria(*,rubric_checks(*)))), submission_files(*), assignment_groups(*, assignment_groups_members(*, profiles!profile_id(*))), grader_results(*, grader_result_tests(*), grader_result_output(*)), submission_artifacts(*)"
    }
  });
  const { data: liveFileComments, isLoading: liveFileCommentsLoading } = useList<SubmissionFileComment>({
    resource: "submission_file_comments",
    filters: [{ field: "submission_id", operator: "eq", value: submission_id }],
    liveMode: "manual",
    pagination: {
      pageSize: 1000
    },
    onLiveEvent: (event) => {
      submissionController.handleGenericDataEvent("submission_file_comments", event);
    }
  });
  const { data: liveReviews, isLoading: liveReviewsLoading } = useList<SubmissionReviewWithRubric>({
    resource: "submission_reviews",
    meta: {
      select: "*, rubrics(*, rubric_criteria(*, rubric_checks(*)))"
    },
    filters: [{ field: "submission_id", operator: "eq", value: submission_id }],
    liveMode: "manual",
    pagination: {
      pageSize: 1000
    },
    onLiveEvent: (event) => {
      submissionController.handleGenericDataEvent("submission_reviews", event);
    }
  });
  const { data: liveComments, isLoading: liveCommentsLoading } = useList<SubmissionComments>({
    resource: "submission_comments",
    filters: [{ field: "submission_id", operator: "eq", value: submission_id }],
    liveMode: "manual",
    pagination: {
      pageSize: 1000
    },
    onLiveEvent: (event) => {
      submissionController.handleGenericDataEvent("submission_comments", event);
    }
  });
  const { data: liveArtifactComments, isLoading: liveArtifactCommentsLoading } = useList<SubmissionArtifactComment>({
    resource: "submission_artifact_comments",
    filters: [{ field: "submission_id", operator: "eq", value: submission_id }],
    liveMode: "manual",
    pagination: {
      pageSize: 1000
    },
    onLiveEvent: (event) => {
      submissionController.handleGenericDataEvent("submission_artifact_comments", event);
    }
  });
  const anyIsLoading =
    liveFileCommentsLoading ||
    liveReviewsLoading ||
    liveCommentsLoading ||
    liveArtifactCommentsLoading ||
    query.isLoading;
  useEffect(() => {
    if (query.data?.data) {
      submissionController.submission = query.data.data;
    }
  }, [submissionController, query.data]);
  useEffect(() => {
    if (!anyIsLoading) {
      setReady(true);
    }
  }, [anyIsLoading, setReady]);
  submissionController.registerGenericDataType(
    "submission_file_comments",
    (item: unknown) => (item as SubmissionFileComment).id
  );
  useEffect(() => {
    if (liveFileComments?.data) {
      submissionController.setGeneric("submission_file_comments", liveFileComments.data);
    }
  }, [submissionController, anyIsLoading, liveFileComments?.data]);
  submissionController.registerGenericDataType(
    "submission_comments",
    (item: unknown) => (item as SubmissionComments).id
  );
  useEffect(() => {
    if (liveComments?.data) {
      submissionController.setGeneric("submission_comments", liveComments.data);
    }
  }, [submissionController, anyIsLoading, liveComments?.data]);
  submissionController.registerGenericDataType(
    "submission_reviews",
    (item: unknown) => (item as SubmissionReviewWithRubric).id
  );
  useEffect(() => {
    if (liveReviews?.data) {
      submissionController.setGeneric("submission_reviews", liveReviews.data);
    }
  }, [submissionController, anyIsLoading, liveReviews?.data]);
  submissionController.registerGenericDataType(
    "submission_artifact_comments",
    (item: unknown) => (item as SubmissionArtifactComment).id
  );
  useEffect(() => {
    if (liveArtifactComments?.data) {
      submissionController.setGeneric("submission_artifact_comments", liveArtifactComments.data);
    }
  }, [submissionController, anyIsLoading, liveArtifactComments?.data]);
  if (query.isLoading || !liveFileComments?.data) {
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

  if (!ctx) {
    return [];
  }
  if (!review_id) {
    return [];
  }
  const comments = [...fileComments, ...submissionComments];
  return comments.filter((c) => c.submission_review_id === review_id);
}
export function useRubricCheckInstances(check: RubricChecks, review_id: number | undefined) {
  const ctx = useContext(SubmissionContext);
  const fileComments = useSubmissionFileComments({});
  const submissionComments = useSubmissionComments({});
  const artifactComments = useSubmissionArtifactComments({});

  if (!ctx) {
    return [];
  }
  if (!review_id) {
    return [];
  }
  const comments = [...fileComments, ...submissionComments, ...artifactComments];
  return comments.filter((c) => check.id === c.rubric_check_id && c.submission_review_id === review_id);
}
export function useSubmissionRubric(reviewAssignmentId?: number | null): {
  rubric: (Database["public"]["Tables"]["rubrics"]["Row"] & { rubric_parts: HydratedRubricPart[] }) | undefined;
  isLoading: boolean;
} {
  const context = useContext(SubmissionContext);
  const { reviewAssignment, isLoading: isLoadingReviewAssignment } = useReviewAssignment(
    reviewAssignmentId ?? undefined
  );

  // Get submission details, but only if context is available
  const submission = context?.submissionController?.submission;
  const rubricIdFromSubmission = submission?.assignments?.grading_rubric_id;
  const rubricIdFromReviewAssignment = reviewAssignment?.rubric_id;

  const finalRubricId = reviewAssignmentId != null ? rubricIdFromReviewAssignment : rubricIdFromSubmission;

  const { query: rubricQuery } = useShow<
    Database["public"]["Tables"]["rubrics"]["Row"] & {
      rubric_parts: HydratedRubricPart[];
    }
  >({
    resource: "rubrics",
    id: finalRubricId || -1,
    queryOptions: {
      enabled: !!finalRubricId && !!context // Also ensure context is loaded before enabling
    },
    meta: {
      select:
        "*, rubric_parts(*, rubric_criteria(*, rubric_checks(*, rubric_check_references_referencing_rubric_check_id(*, rubric_checks!referenced_rubric_check_id(*)))))"
    }
  });

  const rubricDataResult = rubricQuery?.data;
  const isLoadingRubricFromHook = rubricQuery?.isLoading ?? !rubricQuery;

  if (!context) {
    return { rubric: undefined, isLoading: true }; // Still loading if context isn't ready
  }

  let isLoading = isLoadingRubricFromHook;
  if (reviewAssignmentId != null) {
    isLoading = isLoadingReviewAssignment || isLoadingRubricFromHook;
  }

  if (!finalRubricId && !isLoading) {
    return { rubric: undefined, isLoading: false };
  }
  if (reviewAssignmentId != null && !rubricIdFromReviewAssignment && !isLoadingReviewAssignment) {
    // If review assignment was specified, but it (or its rubric_id) wasn't found, and we're done loading it.
    return { rubric: undefined, isLoading: false };
  }

  return { rubric: rubricDataResult?.data, isLoading }; // Refine's useShow often has { data: { data: actualRecord } }
}
export function useRubricCriteriaInstances({
  criteria,
  review_id,
  rubric_id
}: {
  criteria?: RubricCriteriaWithRubricChecks;
  review_id?: number;
  rubric_id?: number;
}) {
  const fileComments = useSubmissionFileComments({});
  const submissionComments = useSubmissionComments({});
  const rubricData = useSubmissionRubric(review_id); // Pass review_id to useSubmissionRubric
  if (!review_id) {
    return [];
  }
  const comments = [...fileComments, ...submissionComments];
  if (criteria) {
    return comments.filter(
      (eachComment) =>
        eachComment.submission_review_id === review_id &&
        criteria.rubric_checks.find((eachCheck: RubricChecks) => eachCheck.id === eachComment.rubric_check_id)
    );
  }
  if (rubric_id) {
    const allCriteria: HydratedRubricCriteria[] =
      rubricData?.rubric?.rubric_parts?.flatMap((part) => part.rubric_criteria || []) || [];
    const allChecks: HydratedRubricCheck[] = allCriteria.flatMap(
      (eachCriteria: HydratedRubricCriteria) => eachCriteria.rubric_checks || []
    );
    return comments.filter(
      (eachComment) =>
        eachComment.submission_review_id === review_id &&
        allChecks.find((eachCheck: HydratedRubricCheck) => eachCheck.id === eachComment.rubric_check_id)
    );
  }
  throw new Error("Either criteria or rubric_id must be provided");
}
export function useSubmissionReview(reviewId?: number | null) {
  const ctx = useContext(SubmissionContext);
  const controller = useSubmissionController();
  const [review, setReview] = useState<SubmissionReviewWithRubric | undefined>(undefined);

  let effectiveReviewId = reviewId;
  if (effectiveReviewId === undefined || effectiveReviewId === null) {
    if (controller?.submission?.grading_review_id) {
      effectiveReviewId = controller.submission.grading_review_id;
    }
  }

  useEffect(() => {
    if (!ctx || !controller || effectiveReviewId === undefined || effectiveReviewId === null) {
      setReview(undefined);
      return;
    }

    const { unsubscribe, data } = controller.getValueWithSubscription<SubmissionReviewWithRubric>(
      "submission_reviews",
      effectiveReviewId,
      (data) => {
        setReview(data);
      }
    );
    setReview(data);
    return () => unsubscribe();
  }, [ctx, controller, effectiveReviewId]);

  if (!ctx) {
    return undefined;
  }

  if (effectiveReviewId === undefined || (effectiveReviewId === null && reviewId === undefined)) {
    // console.warn("No review ID available for useSubmissionReview and no default found.");
  }

  return review;
}
export function useRubricCheck(rubric_check_id: number | null) {
  const context = useContext(SubmissionContext);
  if (!rubric_check_id || !context) {
    return {
      rubricCheck: undefined,
      rubricCriteria: undefined
    };
  }
  const controller = context.submissionController;
  const criteria = controller.submission.assignments.rubrics?.rubric_criteria?.find((c) =>
    c.rubric_checks?.some((c) => c.id === rubric_check_id)
  );
  const check = criteria?.rubric_checks?.find((c) => c.id === rubric_check_id);
  return {
    rubricCheck: check,
    rubricCriteria: criteria
  };
}

export function useSubmissionFile() {
  const controller = useSubmissionController();
  return controller?.file;
}

export function useSubmissionController(): SubmissionController | undefined {
  const ctx = useContext(SubmissionContext);
  return ctx?.submissionController;
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

export function useReviewAssignment(reviewAssignmentId?: number) {
  const { query } = useShow<ReviewAssignmentWithDetails>({
    resource: "review_assignments",
    id: reviewAssignmentId,
    queryOptions: {
      enabled: !!reviewAssignmentId
    },
    meta: {
      select:
        "*, profiles!assignee_profile_id(*), rubrics!inner(*, rubric_parts!inner(*, rubric_criteria!inner(*, rubric_checks!inner(*)))), review_assignment_rubric_parts!inner(*, rubric_parts!inner(*, rubric_criteria!inner(*, rubric_checks!inner(*))))"
    }
  });

  // query might be undefined if the hook is not ready or an issue occurs before it runs
  if (!query) {
    // Return a loading state or an appropriate default if query is not yet available
    return { reviewAssignment: undefined, isLoading: true, error: undefined };
  }

  const { data, isLoading, error } = query;

  if (isLoading) {
    return { reviewAssignment: undefined, isLoading: true, error: undefined };
  }

  if (error) {
    toaster.error({
      title: "Error fetching review assignment",
      description: error.message
    });
    return { reviewAssignment: undefined, isLoading: false, error };
  }

  return { reviewAssignment: data?.data, isLoading: false, error: undefined };
}

export function useSubmissionReviewByAssignmentId(reviewAssignmentId?: number | null): {
  submissionReview: SubmissionReview | undefined;
  isLoading: boolean;
  error: Error | undefined;
} {
  const controller = useSubmissionController();
  const {
    reviewAssignment,
    isLoading: reviewAssignmentLoading,
    error: reviewAssignmentError
  } = useReviewAssignment(reviewAssignmentId ?? undefined);

  const [submissionReview, setSubmissionReview] = useState<SubmissionReview | undefined>(undefined);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | undefined>(undefined);

  useEffect(() => {
    if (!reviewAssignmentId) {
      setSubmissionReview(undefined);
      setIsLoading(false);
      setError(undefined);
      return;
    }

    if (reviewAssignmentLoading) {
      setIsLoading(true);
      return;
    }

    if (reviewAssignmentError) {
      setError(new Error(reviewAssignmentError.message || "Error fetching review assignment details"));
      setIsLoading(false);
      setSubmissionReview(undefined);
      return;
    }

    if (reviewAssignment && controller) {
      // Try to find an existing submission_review
      const { unsubscribe, data: existingReview } = controller.getValueWithSubscription<SubmissionReview>(
        "submission_reviews",
        (sr) =>
          sr.submission_id === reviewAssignment.submission_id &&
          sr.rubric_id === reviewAssignment.rubric_id &&
          sr.grader === reviewAssignment.assignee_profile_id,
        (updatedReview) => {
          setSubmissionReview(updatedReview);
          // Potentially set loading to false if this is the final state we expect after update
        }
      );

      if (existingReview) {
        setSubmissionReview(existingReview);
        setIsLoading(false);
      } else {
        // If no existing review, create a new in-memory one (partial)
        // This will be fully populated and saved when the first rubric check is made or comment posted
        const newReviewPlaceholder: Partial<SubmissionReview> = {
          submission_id: reviewAssignment.submission_id,
          rubric_id: reviewAssignment.rubric_id,
          grader: reviewAssignment.assignee_profile_id,
          class_id: reviewAssignment.class_id,
          name: `Review for submission ${reviewAssignment.submission_id} by ${reviewAssignment.profiles?.name ?? reviewAssignment.assignee_profile_id}`,
          total_score: 0,
          total_autograde_score: 0,
          tweak: 0,
          released: false
          // id will be undefined until saved
        };
        setSubmissionReview(newReviewPlaceholder as SubmissionReview); // Cast for now, ensure downstream handles partial data
        setIsLoading(false);
      }

      return () => unsubscribe();
    } else {
      // Conditions not met to fetch or create a review
      setSubmissionReview(undefined);
      setIsLoading(false);
    }
  }, [reviewAssignmentId, reviewAssignment, reviewAssignmentLoading, reviewAssignmentError, controller]);

  return { submissionReview, isLoading, error };
}

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
  rubric?: Pick<Tables<"rubrics">, "id" | "name" | "review_round">;
  reviewRound?: Enums<"review_round"> | null;
  authorProfile?: Partial<Tables<"profiles">> | null; // Consolidate author profile here
};

// Define a more specific type for comments with author_profile from eager loading
type CommentWithAuthorProfile = (
  | Tables<"submission_file_comments">
  | Tables<"submission_comments">
  | Tables<"submission_artifact_comments">
) & {
  author_profile?: Partial<Tables<"profiles">> | null;
};

export function useReferencedRubricCheckInstances(
  referencing_check_id: number | undefined | null,
  submission_id: number | undefined | null
): { instances: ReferencedRubricCheckInstance[]; isLoading: boolean; error: PostgrestError | Error | null } {
  const supabase = useSupabaseClient<Database>();
  const [instances, setInstances] = useState<ReferencedRubricCheckInstance[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<PostgrestError | Error | null>(null);

  useEffect(() => {
    if (!referencing_check_id || !submission_id || !supabase) {
      setInstances([]);
      // setIsLoading(referencing_check_id && submission_id ? true : false); // Original
      // Corrected logic: only set loading true if we intend to fetch
      setIsLoading(!!(referencing_check_id && submission_id && supabase));
      if (!supabase && referencing_check_id && submission_id) {
        // Waiting for supabase client, setIsLoading(true) is appropriate if we expect supabase to appear
        // For simplicity, if supabase is null, we are not loading yet from this hook's perspective for this run.
        // The initial true might be okay if supabase is guaranteed to load shortly.
        // Let's stick to false if critical deps are missing to avoid infinite loading states if supabase never arrives.
        setIsLoading(false);
      }
      return;
    }

    let isMounted = true;
    setIsLoading(true);
    setError(null);

    const fetchInstances = async () => {
      try {
        const { data: references, error: referencesError } = await supabase
          .from("rubric_check_references")
          .select("*")
          .eq("referencing_rubric_check_id", referencing_check_id);

        if (referencesError) throw referencesError;
        if (!isMounted || !references || references.length === 0) {
          if (isMounted) setInstances([]);
          return;
        }

        const collectedInstances: ReferencedRubricCheckInstance[] = [];

        for (const ref of references) {
          const referenced_rubric_check_id = ref.referenced_rubric_check_id;

          const { data: referencedCheck, error: referencedCheckError } = await supabase
            .from("rubric_checks")
            .select("*")
            .eq("id", referenced_rubric_check_id)
            .single();

          if (referencedCheckError) {
            toaster.create({
              title: `Error fetching referenced check ${referenced_rubric_check_id}`,
              description: referencedCheckError.message,
              type: "warning"
            });
            continue;
          }
          if (!referencedCheck) continue;

          const allCommentsSource: {
            type: "file" | "general" | "artifact";
            data: CommentWithAuthorProfile[] | null;
            error: PostgrestError | null;
          }[] = [];

          const fileCommentsResult = await supabase
            .from("submission_file_comments")
            .select(
              "*, author_profile:profiles!submission_file_comments_author_fkey(id, name, avatar_url, flair, short_name)"
            )
            .eq("rubric_check_id", referenced_rubric_check_id)
            .eq("submission_id", submission_id);
          allCommentsSource.push({
            type: "file",
            data: fileCommentsResult.data as CommentWithAuthorProfile[] | null,
            error: fileCommentsResult.error
          });

          const generalCommentsResult = await supabase
            .from("submission_comments")
            .select(
              "*, author_profile:profiles!submission_comments_author_fkey(id, name, avatar_url, flair, short_name)"
            )
            .eq("rubric_check_id", referenced_rubric_check_id)
            .eq("submission_id", submission_id);
          allCommentsSource.push({
            type: "general",
            data: generalCommentsResult.data as CommentWithAuthorProfile[] | null,
            error: generalCommentsResult.error
          });

          const artifactCommentsResult = await supabase
            .from("submission_artifact_comments")
            .select(
              "*, author_profile:profiles!submission_artifact_comments_author_fkey(id, name, avatar_url, flair, short_name)"
            )
            .eq("rubric_check_id", referenced_rubric_check_id)
            .eq("submission_id", submission_id);
          allCommentsSource.push({
            type: "artifact",
            data: artifactCommentsResult.data as CommentWithAuthorProfile[] | null,
            error: artifactCommentsResult.error
          });

          for (const source of allCommentsSource) {
            if (source.error) {
              toaster.create({
                title: `Error fetching ${source.type} comments:`,
                description: source.error.message,
                type: "warning"
              });
            }
            if (!source.data) continue;

            for (const rawComment of source.data) {
              // rawComment is now CommentWithAuthorProfile
              const comment = {
                ...rawComment,
                type: source.type
                // author_profile is already part of rawComment due to CommentWithAuthorProfile type
              } as ReferencedRubricCheckInstance["comment"];

              let submissionReview: Tables<"submission_reviews"> | undefined = undefined;
              let rubric: Pick<Tables<"rubrics">, "id" | "name" | "review_round"> | undefined = undefined;
              let reviewRound: Enums<"review_round"> | null = null;
              const authorProfile = comment.author_profile || undefined;

              if (comment.submission_review_id) {
                const { data: reviewData, error: reviewError } = await supabase
                  .from("submission_reviews")
                  .select("*")
                  .eq("id", comment.submission_review_id)
                  .single();

                if (reviewError) {
                  toaster.create({
                    title: "Error fetching submission review:",
                    description: reviewError.message,
                    type: "warning"
                  });
                } else submissionReview = reviewData || undefined;

                if (submissionReview && submissionReview.rubric_id) {
                  const { data: rubricData, error: rubricError } = await supabase
                    .from("rubrics")
                    .select("id, name, review_round")
                    .eq("id", submissionReview.rubric_id)
                    .single();
                  if (rubricError) {
                    toaster.create({
                      title: "Error fetching rubric:",
                      description: rubricError.message,
                      type: "warning"
                    });
                  } else {
                    rubric = rubricData || undefined;
                    reviewRound = rubric?.review_round || null;
                  }
                }
              }
              collectedInstances.push({
                referencedRubricCheck: referencedCheck,
                comment,
                submissionReview,
                rubric,
                reviewRound,
                authorProfile
              });
            }
          }
        }
        if (isMounted) setInstances(collectedInstances);
      } catch (e: unknown) {
        toaster.error({
          title: "Error fetching referenced rubric check instances:",
          description: e instanceof Error ? e.message : "An unknown error occurred"
        });
        if (isMounted) {
          if (e instanceof Error) {
            setError(e);
          } else if (typeof e === "object" && e !== null && "message" in e) {
            setError(new Error(String(e.message)));
          } else {
            setError(new Error("An unknown error occurred"));
          }
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };

    fetchInstances();

    return () => {
      isMounted = false;
    };
  }, [referencing_check_id, submission_id, supabase]);

  return { instances, isLoading, error };
}
