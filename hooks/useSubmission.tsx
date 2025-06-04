"use client";
import { toaster } from "@/components/ui/toaster";
import {
  useAssignmentController,
  useMyReviewAssignments,
  useRubricCheck as useNewRubricCheck,
  useReferencingRubricChecks,
  useRubrics
} from "@/hooks/useAssignment";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import {
  HydratedRubric,
  HydratedRubricCheck,
  HydratedRubricCriteria,
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
  SubmissionWithAllRelatedData,
  SubmissionWithFilesGraderResultsOutputTestsAndRubric
} from "@/utils/supabase/DatabaseTypes";
import { Database, Enums, Tables } from "@/utils/supabase/SupabaseTypes";
import { Spinner, Text } from "@chakra-ui/react";
import { LiveEvent, useList, useShow } from "@refinedev/core";
import { useParams } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Unsubscribe } from "./useCourseController";
import { SubmissionReviewProvider } from "./useSubmissionReview";

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
          const filteredData = data.filter(filter as (value: unknown) => boolean);
          const filteredEntered = entered.filter(filter as (value: unknown) => boolean);
          const filteredLeft = left.filter(filter as (value: unknown) => boolean);
          const filteredUpdated = updated.filter(filter as (value: unknown) => boolean);
          (callback as ListUpdateCallback<unknown>)(filteredData, {
            entered: filteredEntered,
            left: filteredLeft,
            updated: filteredUpdated
          });
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
            this.genericDataListSubscribers[typeName]?.filter((cb) => cb !== filteredCallback) || [];
        },
        data: (Array.from(currentData) as T[]).filter(filter)
      };
    }
    return {
      unsubscribe: () => {
        this.genericDataListSubscribers[typeName] =
          this.genericDataListSubscribers[typeName]?.filter((cb) => cb !== filteredCallback) || [];
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
          unsubscribe: () => { },
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

    if (!idGetter) {
      toaster.error({
        title: "Error",
        description: `No id getter registered for type ${typeName}`
      });
      return;
    }

    const id = idGetter(body);

    // Ensure the maps are initialized before handling events
    if (!this.genericData[typeName]) {
      this.genericData[typeName] = new Map();
    }
    if (!this.genericDataSubscribers[typeName]) {
      this.genericDataSubscribers[typeName] = new Map();
    }
    if (!this.genericDataListSubscribers[typeName]) {
      this.genericDataListSubscribers[typeName] = [];
    }

    if (event.type === "created") {
      this.genericData[typeName].set(id, body);
      this.genericDataSubscribers[typeName]?.get(id)?.forEach((cb) => cb(body));
      this.genericDataListSubscribers[typeName]?.forEach((cb) => {
        const allData = Array.from(this.genericData[typeName].values());
        cb(allData, { entered: [body], left: [], updated: [] });
      });
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
  constructor() { }

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
      {ready && <SubmissionReviewProvider>{children}</SubmissionReviewProvider>}
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
        const filteredData = data.filter((comment) => comment.deleted_at === null);
        setComments(filteredData);
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

  // Register all generic data types BEFORE setting up live subscriptions
  submissionController.registerGenericDataType(
    "submission_file_comments",
    (item: unknown) => (item as SubmissionFileComment).id
  );
  submissionController.registerGenericDataType(
    "submission_comments",
    (item: unknown) => (item as SubmissionComments).id
  );
  submissionController.registerGenericDataType(
    "submission_reviews",
    (item: unknown) => (item as SubmissionReviewWithRubric).id
  );
  submissionController.registerGenericDataType(
    "submission_artifact_comments",
    (item: unknown) => (item as SubmissionArtifactComment).id
  );

  // Single comprehensive query to load all data upfront
  const { query } = useShow<SubmissionWithAllRelatedData>({
    resource: "submissions",
    id: submission_id,
    meta: {
      select: `
        *,
        assignments(*, rubrics!grading_rubric_id(*,rubric_criteria(*,rubric_checks(*)))),
        submission_files(*),
        assignment_groups(*, assignment_groups_members(*, profiles!profile_id(*))),
        grader_results(*, grader_result_tests(*), grader_result_output(*)),
        submission_artifacts(*),
        submission_file_comments(*),
        submission_comments(*),
        submission_reviews!submission_reviews_submission_id_fkey(*, rubrics(*, rubric_parts(*, rubric_criteria(*, rubric_checks(*))))),
        submission_artifact_comments!submission_artifact_comments_submission_id_fkey(*)
      `.trim()
    }
  });

  // Set up live subscriptions with proper event handling
  // We need these enabled to receive live events, but we'll ignore the initial data since we already loaded it
  const [liveSubscriptionsReady, setLiveSubscriptionsReady] = useState(false);

  useList<SubmissionFileComment>({
    resource: "submission_file_comments",
    filters: [{ field: "submission_id", operator: "eq", value: submission_id }],
    pagination: {
      pageSize: 1000
    },
    liveMode: "manual",
    queryOptions: {
      enabled: true, // Need to enable to receive live events
      refetchOnMount: false, // Don't refetch on mount since we have data
      refetchOnReconnect: true,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      cacheTime: Infinity
    },
    onLiveEvent: (event) => {
      submissionController.handleGenericDataEvent("submission_file_comments", event);
    }
  });

  useList<SubmissionReviewWithRubric>({
    resource: "submission_reviews",
    meta: {
      select: "*, rubrics(*, rubric_criteria(*, rubric_checks(*)))"
    },
    filters: [{ field: "submission_id", operator: "eq", value: submission_id }],
    pagination: {
      pageSize: 1000
    },
    liveMode: "manual",
    queryOptions: {
      enabled: true, // Need to enable to receive live events
      refetchOnMount: false,
      refetchOnReconnect: true,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      cacheTime: Infinity
    },
    onLiveEvent: (event) => {
      submissionController.handleGenericDataEvent("submission_reviews", event);
    }
  });

  useList<SubmissionComments>({
    resource: "submission_comments",
    filters: [{ field: "submission_id", operator: "eq", value: submission_id }],
    pagination: {
      pageSize: 1000
    },
    liveMode: "manual",
    queryOptions: {
      enabled: true, // Need to enable to receive live events
      refetchOnMount: false,
      refetchOnReconnect: true,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      cacheTime: Infinity
    },
    onLiveEvent: (event) => {
      submissionController.handleGenericDataEvent("submission_comments", event);
    }
  });

  useList<SubmissionArtifactComment>({
    resource: "submission_artifact_comments",
    filters: [{ field: "submission_id", operator: "eq", value: submission_id }],
    pagination: {
      pageSize: 1000
    },
    liveMode: "manual",
    queryOptions: {
      enabled: true, // Need to enable to receive live events
      refetchOnMount: false,
      refetchOnReconnect: true,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      cacheTime: Infinity
    },
    onLiveEvent: (event) => {
      submissionController.handleGenericDataEvent("submission_artifact_comments", event);
    }
  });

  // Process the main query data once it's loaded
  useEffect(() => {
    if (query.data?.data && !query.isLoading) {
      const data = query.data.data;

      // Set the main submission data (without the extra fields)
      const {
        submission_file_comments,
        submission_comments,
        submission_reviews,
        submission_artifact_comments,
        ...submissionData
      } = data;

      submissionController.submission = submissionData as SubmissionWithFilesGraderResultsOutputTestsAndRubric;

      // Set all the related data
      if (submission_file_comments) {
        submissionController.setGeneric("submission_file_comments", submission_file_comments);
      }
      if (submission_comments) {
        submissionController.setGeneric("submission_comments", submission_comments);
      }
      if (submission_reviews) {
        submissionController.setGeneric("submission_reviews", submission_reviews);
      }
      if (submission_artifact_comments) {
        submissionController.setGeneric("submission_artifact_comments", submission_artifact_comments);
      }

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
        "*, rubric_parts(*, rubric_criteria(*, rubric_checks(*, rubric_check_references!referencing_rubric_check_id(*, rubric_checks!referenced_rubric_check_id(*)))))"
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
  }, [fileComments, submissionComments, review_id, criteria, rubric_id, rubricData]);

  return filteredComments;
}
export function useSubmissionReviews() {
  const ctx = useContext(SubmissionContext);
  const controller = useSubmissionController();
  const [reviews, setReviews] = useState<SubmissionReviewWithRubric[] | undefined>(undefined);
  useEffect(() => {
    if (!ctx || !controller) {
      return;
    }
    const { unsubscribe, data } = controller.listGenericData<SubmissionReviewWithRubric>(
      "submission_reviews",
      (data) => {
        setReviews(data);
      }
    );
    setReviews(data);
    return () => unsubscribe();
  }, [ctx, controller]);
  return reviews;
}

export function useSubmissionReviewOrGradingReview(reviewId?: number | null) {
  const ctx = useContext(SubmissionContext);
  const controller = useSubmissionController();
  const [review, setReview] = useState<SubmissionReviewWithRubric | undefined>(undefined);

  useEffect(() => {
    if (!ctx || !controller || (!reviewId && !ctx.submissionController.submission.grading_review_id)) {
      setReview(undefined);
      return;
    }
    const effectiveReviewId = reviewId || ctx.submissionController.submission.grading_review_id;

    const { unsubscribe, data } = controller.getValueWithSubscription<SubmissionReviewWithRubric>(
      "submission_reviews",
      effectiveReviewId ?? -1,
      (data) => {
        setReview(data);
      }
    );
    setReview(data);
    return () => unsubscribe();
  }, [ctx, controller, reviewId]);

  if (!ctx || !reviewId) {
    return undefined;
  }

  if (!reviewId && !ctx.submissionController.submission.grading_review_id) {
    toaster.create({
      title: "No review ID available",
      description:
        "No review ID available for useSubmissionReview and no default found. This is likely a bug. Please contact support.",
      type: "warning"
    });
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
  const criteria = controller.submission.assignments.rubrics?.rubric_criteria?.find((c: HydratedRubricCriteria) =>
    c.rubric_checks?.some((c: HydratedRubricCheck) => c.id === rubric_check_id)
  );
  const check = criteria?.rubric_checks?.find((c: HydratedRubricCheck) => c.id === rubric_check_id);
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

export function useReviewAssignment(reviewAssignmentId?: number) {
  const idForHook = reviewAssignmentId === undefined ? -1 : reviewAssignmentId;
  const queryEnabled = !!reviewAssignmentId; // True if reviewAssignmentId is a truthy number

  const { query } = useShow<ReviewAssignmentWithDetails>({
    resource: "review_assignments",
    id: idForHook,
    queryOptions: {
      enabled: queryEnabled
    },
    meta: {
      select:
        "*, profiles!assignee_profile_id(*), rubrics(*, rubric_parts(*, rubric_criteria(*, rubric_checks(*)))), review_assignment_rubric_parts(*, rubric_parts(*, rubric_criteria(*, rubric_checks(*))))"
    }
  });

  // If the query was never meant to be enabled (original ID was undefined, 0, or NaN),
  // return a non-loading, no-data state immediately.
  if (!queryEnabled) {
    return { reviewAssignment: undefined, isLoading: false, error: undefined };
  }

  // query might be undefined if the hook is not ready or an issue occurs before it runs
  if (!query) {
    // This state might occur if useShow is called but react-query hasn't fully initialized its result.
    // Given queryEnabled is true, we expect it to be loading.
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
  rubric?: Pick<Tables<"rubrics">, "id" | "name" | "review_round" | "assignment_id">;
  reviewRound?: Enums<"review_round"> | null;
  authorProfile?: Partial<Tables<"profiles">> | null;
};

export function useReferencedRubricCheckInstances(referencing_check_id: number | undefined | null) {
  // Get comments from submission controller instead of separate queries
  const fileComments = useSubmissionFileComments({});
  const submissionComments = useSubmissionComments({});
  const artifactComments = useSubmissionArtifactComments({});

  const referencingCheck = useNewRubricCheck(referencing_check_id);

  const allRelevantComments = useMemo(() => {
    const referencedCheckIds = referencingCheck?.rubric_check_references.map((ref) => ref.referenced_rubric_check_id);
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
  }, [fileComments, submissionComments, artifactComments, referencingCheck]);

  return allRelevantComments;
}

export function useSubmissionReviewForRubric(rubricId?: number | null): SubmissionReview | undefined {
  const ctx = useContext(SubmissionContext);
  const controller = ctx?.submissionController;
  const submission = controller?.submission;
  const { private_profile_id } = useClassProfiles();

  const [submissionReview, setSubmissionReview] = useState<SubmissionReview | undefined>(undefined);

  useEffect(() => {
    if (!rubricId || !submission || !controller || !private_profile_id) {
      setSubmissionReview(undefined);
      return;
    }

    // Try to find an existing submission review for this rubric
    const { unsubscribe, data: existingReview } = controller.getValueWithSubscription<SubmissionReview>(
      "submission_reviews",
      (sr) => sr.submission_id === submission.id && sr.rubric_id === rubricId,
      (updatedReview) => {
        setSubmissionReview(updatedReview);
      }
    );

    if (existingReview) {
      setSubmissionReview(existingReview);
    } else {
      setSubmissionReview(undefined);
    }

    return () => unsubscribe();
  }, [rubricId, submission, controller, private_profile_id]);

  return submissionReview;
}
export function useWritableReferencingRubricChecks(rubric_check_id: number | null | undefined) {
  const assignmentController = useAssignmentController();
  const referencingChecks = useReferencingRubricChecks(rubric_check_id)?.map((eachCheck) => {
    const reviewCriteria = assignmentController.rubricCriteriaById.get(eachCheck.rubric_criteria_id);
    return {
      criteria: reviewCriteria,
      check: eachCheck
    };
  });
  const writableSubmissionReviews = useWritableSubmissionReviews();
  return referencingChecks?.filter((rc) =>
    writableSubmissionReviews?.some((sr) => sr.rubric_id === rc.criteria!.rubric_id)
  );
}

export function useWritableSubmissionReviews(rubric_id?: number) {
  const id = useSubmissionController().submission.id;
  const submissionReviews = useSubmissionReviews();
  const rubrics = useRubrics();
  const assignments = useMyReviewAssignments(id);

  const { role } = useClassProfiles();
  const memoizedReviews = useMemo(() => {
    const writableRubrics: HydratedRubric[] = [];
    if (role.role === "instructor") {
      writableRubrics.push(...rubrics);
    }
    if (role.role === "grader") {
      writableRubrics.push(
        ...rubrics.filter((r) => r.review_round === "grading-review" || assignments.some((a) => a.rubric_id === r.id))
      );
    }
    if (role.role === "student") {
      writableRubrics.push(
        ...rubrics.filter((r) => r.review_round === "self-review" || assignments.some((a) => a.rubric_id === r.id))
      );
    }
    return submissionReviews?.filter(
      (sr) =>
        writableRubrics.some((r) => r.id === sr.rubric_id) &&
        (rubric_id === undefined || sr.rubric_id === rubric_id) &&
        (role.role === "instructor" || role.role == "grader" || !sr.completed_at)
    );
  }, [role, rubrics, submissionReviews, assignments, rubric_id]);
  return memoizedReviews;
}
