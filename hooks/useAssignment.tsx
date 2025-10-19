"use client";
import {
  AssignmentWithRubricsAndReferences,
  RegradeRequest,
  ReviewAssignmentParts,
  ReviewAssignments,
  Rubric,
  RubricCheck,
  RubricCheckReference,
  RubricCriteria,
  RubricPart,
  RubricReviewRound,
  Submission
} from "@/utils/supabase/DatabaseTypes";

import { ClassRealTimeController } from "@/lib/ClassRealTimeController";
import type { AssignmentControllerInitialData } from "@/lib/ssrUtils";
import TableController, {
  useFindTableControllerValue,
  useListTableControllerValues,
  useTableControllerTableValues,
  useTableControllerValueById
} from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Text } from "@chakra-ui/react";
import { useList, useShow } from "@refinedev/core";
import { SupabaseClient } from "@supabase/supabase-js";
import { useParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useClassProfiles } from "./useClassProfiles";
import { useCourseController } from "./useCourseController";

export function useSubmission(submission_id: number | null | undefined) {
  const controller = useAssignmentController();
  const [submission, setSubmission] = useState<Submission | undefined>(undefined);
  useEffect(() => {
    if (!submission_id) {
      setSubmission(undefined);
      return;
    }
    const { data, unsubscribe } = controller.submissions.getById(submission_id, (data) => {
      setSubmission(data);
    });
    setSubmission(data);
    return () => unsubscribe();
  }, [controller, submission_id]);
  return submission;
}

export function useAssignmentGroups() {
  const controller = useAssignmentController();
  return useTableControllerTableValues(controller.assignmentGroups);
}

export function useAssignmentGroup(assignment_group_id: number | null | undefined) {
  const controller = useAssignmentController();
  return useTableControllerValueById(controller.assignmentGroups, assignment_group_id);
}

export function useSelfReviewSettings() {
  const controller = useAssignmentController();
  return controller.assignment.assignment_self_review_settings;
}

export function useRubricCheck(rubric_check_id: number | null | undefined) {
  const controller = useAssignmentController();
  return useTableControllerValueById(controller.rubricChecksController, rubric_check_id);
}

export function useRubricCriteria(rubric_criteria_id: number | null | undefined) {
  const controller = useAssignmentController();
  return useTableControllerValueById(controller.rubricCriteriaController, rubric_criteria_id);
}
export function useRubricById(rubric_id: number | undefined | null) {
  const controller = useAssignmentController();
  return useTableControllerValueById(controller.rubricsController, rubric_id);
}

/**
 * Returns a rubric with its parts populated (no deeper nesting)
 */
export function useRubricWithParts(rubric_id: number | null | undefined) {
  const rubric = useTableControllerValueById(useAssignmentController().rubricsController, rubric_id);
  const parts = useRubricParts(rubric_id);

  return useMemo(() => {
    if (!rubric) return undefined;
    return {
      ...rubric,
      rubric_parts: parts
    };
  }, [rubric, parts]);
}

export function useRubric(review_round: RubricReviewRound) {
  const findRubricPredicate = useCallback((rubric: Rubric) => rubric.review_round === review_round, [review_round]);
  const controller = useAssignmentController();
  return useFindTableControllerValue(controller.rubricsController, findRubricPredicate);
}

/**
 * Returns a rubric by review_round with its parts populated
 */
export function useRubricWithPartsByReviewRound(review_round: RubricReviewRound) {
  const rubric = useRubric(review_round);
  const parts = useRubricParts(rubric?.id);

  return useMemo(() => {
    if (!rubric) return undefined;
    return {
      ...rubric,
      rubric_parts: parts
    };
  }, [rubric, parts]);
}

export function useRubrics() {
  const controller = useAssignmentController();
  return useTableControllerTableValues(controller.rubricsController);
}

/**
 * Returns all rubric parts for a specific rubric
 */
export function useRubricParts(rubric_id: number | null | undefined) {
  const controller = useAssignmentController();
  const findRubricPartsPredicate = useCallback(
    (rubric_part: RubricPart) => rubric_part.rubric_id === rubric_id,
    [rubric_id]
  );
  return useListTableControllerValues(controller.rubricPartsController, findRubricPartsPredicate);
}

/**
 * Returns all rubric criteria for a specific rubric
 */
export function useRubricCriteriaByRubric(rubric_id: number | null | undefined) {
  const controller = useAssignmentController();
  const findRubricCriteriaPredicate = useCallback(
    (rubric_criteria: RubricCriteria) => rubric_criteria.rubric_id === rubric_id,
    [rubric_id]
  );
  return useListTableControllerValues(controller.rubricCriteriaController, findRubricCriteriaPredicate);
}

/**
 * Returns all rubric checks for a specific rubric
 */
export function useRubricChecksByRubric(rubric_id: number | null | undefined) {
  const controller = useAssignmentController();
  const findRubricChecksPredicate = useCallback(
    (rubric_check: RubricCheck) => rubric_check.rubric_id === rubric_id,
    [rubric_id]
  );
  return useListTableControllerValues(controller.rubricChecksController, findRubricChecksPredicate);
}

/**
 * Returns all rubric criteria for a specific rubric part
 */
export function useRubricCriteriaByPart(rubric_part_id: number | null | undefined) {
  const controller = useAssignmentController();
  const findRubricCriteriaPredicate = useCallback(
    (rubric_criteria: RubricCriteria) => rubric_criteria.rubric_part_id === rubric_part_id,
    [rubric_part_id]
  );
  return useListTableControllerValues(controller.rubricCriteriaController, findRubricCriteriaPredicate);
}

/**
 * Returns all rubric checks for a specific rubric criteria
 */
export function useRubricChecksByCriteria(rubric_criteria_id: number | null | undefined) {
  const controller = useAssignmentController();
  const findRubricChecksPredicate = useCallback(
    (rubric_check: RubricCheck) => rubric_check.rubric_criteria_id === rubric_criteria_id,
    [rubric_criteria_id]
  );
  return useListTableControllerValues(controller.rubricChecksController, findRubricChecksPredicate);
}

/**
 * Returns all rubric checks for the assignment (not filtered by criteria)
 */
export function useAllRubricChecks() {
  const controller = useAssignmentController();
  return useTableControllerTableValues(controller.rubricChecksController);
}

export function useReviewAssignmentRubricParts(review_assignment_id: number | null | undefined) {
  const controller = useAssignmentController();
  const [parts, setParts] = useState<ReviewAssignmentParts[]>([]);

  const partsController = useMemo(() => {
    if (!review_assignment_id) return null;
    return controller.getReviewAssignmentRubricPartsController(review_assignment_id);
  }, [controller, review_assignment_id]);

  useEffect(() => {
    if (!partsController) {
      setParts([]);
      return;
    }
    const { unsubscribe, data } = partsController.list((data) => {
      setParts(data as unknown as ReviewAssignmentParts[]);
    });
    setParts(data as unknown as ReviewAssignmentParts[]);
    return () => {
      unsubscribe();
      if (review_assignment_id) {
        controller.releaseReviewAssignmentRubricPartsController(review_assignment_id);
      }
    };
  }, [partsController, controller, review_assignment_id]);

  return parts;
}
export function useActiveSubmissions() {
  const controller = useAssignmentController();
  const [submissions, setSubmissions] = useState<Submission[]>(controller.submissions.rows);
  useEffect(() => {
    const { data, unsubscribe } = controller.submissions.list(setSubmissions);
    setSubmissions(data);
    return () => unsubscribe();
  }, [controller]);
  return submissions;
}
export function useReviewAssignment(review_assignment_id: number | null | undefined) {
  const controller = useAssignmentController();

  const [reviewAssignment, setReviewAssignment] = useState<ReviewAssignments | undefined>(undefined);
  useEffect(() => {
    if (!review_assignment_id) {
      setReviewAssignment(undefined);
      return;
    }
    const { data, unsubscribe } = controller.reviewAssignments.getById(review_assignment_id, (data) => {
      setReviewAssignment(data);
    });
    setReviewAssignment(data);
    return () => unsubscribe();
  }, [controller, review_assignment_id]);
  return reviewAssignment;
}

export function useMyReviewAssignments(submission_id?: number) {
  const controller = useAssignmentController();
  const { private_profile_id } = useClassProfiles();
  const filter = useCallback(
    (reviewAssignment: ReviewAssignments) => {
      return (
        reviewAssignment.assignee_profile_id === private_profile_id &&
        (submission_id ? reviewAssignment.submission_id === submission_id : true)
      );
    },
    [private_profile_id, submission_id]
  );
  return useListTableControllerValues(controller.reviewAssignments, filter);
}

/**
 * Returns all rubric checks that reference the specified rubric check ID.
 *
 * @param rubric_check_id - The ID of the rubric check being referenced
 * @returns An array of referencing rubric checks, or undefined if no ID is provided
 */
export function useReferencingRubricChecks(rubric_check_id: number | null | undefined) {
  const controller = useAssignmentController();
  const findReferencingRubricChecksPredicate = useCallback(
    (rubric_check_reference: RubricCheckReference) =>
      rubric_check_reference.referencing_rubric_check_id === rubric_check_id,
    [rubric_check_id]
  );
  const referencingCheckVals = useListTableControllerValues(
    controller.rubricCheckReferencesController,
    findReferencingRubricChecksPredicate
  );
  return referencingCheckVals;
}

export function useReferenceCheckRecordsFromCheck(rubric_check_id: number | null | undefined) {
  const controller = useAssignmentController();
  const findReferencingRubricChecksPredicate = useCallback(
    (rubric_check_reference: RubricCheckReference) =>
      rubric_check_reference.referencing_rubric_check_id === rubric_check_id,
    [rubric_check_id]
  );
  return useListTableControllerValues(controller.rubricCheckReferencesController, findReferencingRubricChecksPredicate);
}

export function useReferencedRubricChecks(rubric_check_id: number | null | undefined) {
  const controller = useAssignmentController();
  const findReferencedRubricChecksPredicate = useCallback(
    (rubric_check_reference: RubricCheckReference) =>
      rubric_check_reference.referencing_rubric_check_id === rubric_check_id,
    [rubric_check_id]
  );
  const referencedCheckVals = useListTableControllerValues(
    controller.rubricCheckReferencesController,
    findReferencedRubricChecksPredicate
  );
  const findChecksPredicate = useCallback(
    (rubric_check: RubricCheck) =>
      referencedCheckVals?.find((ref) => ref.referenced_rubric_check_id === rubric_check.id) !== undefined,
    [referencedCheckVals]
  );
  return useListTableControllerValues(controller.rubricChecksController, findChecksPredicate);
}
/**
 * Subscribes to and returns all regrade requests for the current assignment.
 *
 * The returned array updates in real time as regrade requests are added, modified, or removed.
 *
 * @returns An array of regrade requests associated with the current assignment.
 */
export function useRegradeRequests() {
  const controller = useAssignmentController();
  return useTableControllerTableValues(controller.regradeRequests);
}

/**
 * Subscribes to and returns a single regrade request by its ID, updating the value in real time as the data changes.
 *
 * @param regrade_request_id - The ID of the regrade request to retrieve, or `null`/`undefined` to disable the subscription.
 * @returns The regrade request with the specified ID, or `undefined` if not found or if the ID is not provided.
 */
export function useRegradeRequest(regrade_request_id: number | null | undefined) {
  const controller = useAssignmentController();
  return useTableControllerValueById(controller.regradeRequests, regrade_request_id);
}

/**
 * Returns all regrade requests associated with a specific submission.
 *
 * @param submission_id - The ID of the submission to filter regrade requests by
 * @returns An array of regrade requests for the given submission ID
 */
export function useRegradeRequestsBySubmission(submission_id: number | null | undefined) {
  const controller = useAssignmentController();
  const findRegradeRequestsPredicate = useCallback(
    (regrade_request: RegradeRequest) => regrade_request.submission_id === submission_id,
    [submission_id]
  );
  return useListTableControllerValues(controller.regradeRequests, findRegradeRequestsPredicate);
}

export class AssignmentController {
  private _assignment?: AssignmentWithRubricsAndReferences;
  private _client: SupabaseClient<Database>;
  private _classRealTimeController: ClassRealTimeController;

  readonly reviewAssignments: TableController<"review_assignments">;
  readonly regradeRequests: TableController<"submission_regrade_requests">;
  readonly submissions: TableController<"submissions">;
  readonly assignmentGroups: TableController<"assignment_groups">;

  // Rubric table controllers
  readonly rubricsController: TableController<"rubrics">;
  readonly rubricPartsController: TableController<"rubric_parts">;
  readonly rubricCriteriaController: TableController<"rubric_criteria">;
  readonly rubricChecksController: TableController<"rubric_checks">;
  readonly rubricCheckReferencesController: TableController<"rubric_check_references">;

  private _reviewAssignmentRubricPartsByReviewAssignmentId: Map<
    number,
    TableController<"review_assignment_rubric_parts">
  > = new Map();
  private _reviewAssignmentRubricPartsRefCount: Map<number, number> = new Map();

  constructor({
    client,
    assignment_id,
    classRealTimeController,
    initialData
  }: {
    client: SupabaseClient<Database>;
    assignment_id: number;
    classRealTimeController: ClassRealTimeController;
    initialData?: AssignmentControllerInitialData;
  }) {
    this._client = client;
    this._classRealTimeController = classRealTimeController;
    this.submissions = new TableController({
      query: client.from("submissions").select("*").eq("assignment_id", assignment_id).eq("is_active", true),
      client: client,
      table: "submissions",
      classRealTimeController,
      initialData: initialData?.submissions
    });
    this.assignmentGroups = new TableController({
      query: client.from("assignment_groups").select("*").eq("assignment_id", assignment_id),
      client: client,
      table: "assignment_groups",
      classRealTimeController,
      initialData: initialData?.assignmentGroups
    });
    this.reviewAssignments = new TableController({
      query: client
        .from("review_assignments")
        .select("*")
        .eq("assignment_id", assignment_id)
        .eq("assignee_profile_id", classRealTimeController.profileId),
      client: client,
      table: "review_assignments",
      classRealTimeController
    });
    this.regradeRequests = new TableController({
      query: client.from("submission_regrade_requests").select("*").eq("assignment_id", assignment_id),
      client: client,
      table: "submission_regrade_requests",
      classRealTimeController,
      initialData: initialData?.regradeRequests
    });

    // Initialize rubric table controllers - each filtered by assignment_id
    this.rubricsController = new TableController({
      query: client.from("rubrics").select("*").eq("assignment_id", assignment_id),
      client: client,
      table: "rubrics",
      classRealTimeController,
      realtimeFilter: { assignment_id },
      initialData: initialData?.rubrics
    });

    this.rubricPartsController = new TableController({
      query: client.from("rubric_parts").select("*").eq("assignment_id", assignment_id),
      client: client,
      table: "rubric_parts",
      classRealTimeController,
      realtimeFilter: { assignment_id },
      initialData: initialData?.rubricParts
    });

    this.rubricCriteriaController = new TableController({
      query: client.from("rubric_criteria").select("*").eq("assignment_id", assignment_id),
      client: client,
      table: "rubric_criteria",
      classRealTimeController,
      realtimeFilter: { assignment_id },
      initialData: initialData?.rubricCriteria
    });

    this.rubricChecksController = new TableController({
      query: client.from("rubric_checks").select("*").eq("assignment_id", assignment_id),
      client: client,
      table: "rubric_checks",
      classRealTimeController,
      realtimeFilter: { assignment_id },
      initialData: initialData?.rubricChecks
    });

    this.rubricCheckReferencesController = new TableController({
      query: client.from("rubric_check_references").select("*").eq("assignment_id", assignment_id),
      client: client,
      table: "rubric_check_references",
      classRealTimeController,
      realtimeFilter: { assignment_id },
      initialData: initialData?.rubricCheckReferences
    });
  }
  close() {
    this.reviewAssignments.close();
    this.regradeRequests.close();
    this.submissions.close();
    this.assignmentGroups.close();

    // Close rubric table controllers
    this.rubricsController.close();
    this.rubricPartsController.close();
    this.rubricCriteriaController.close();
    this.rubricChecksController.close();
    this.rubricCheckReferencesController.close();

    for (const controller of this._reviewAssignmentRubricPartsByReviewAssignmentId.values()) {
      controller.close();
    }
    this._reviewAssignmentRubricPartsByReviewAssignmentId.clear();
  }
  // Assignment
  set assignment(assignment: AssignmentWithRubricsAndReferences) {
    if (this._assignment) {
      return;
    }
    this._assignment = assignment;
  }
  get assignment() {
    if (!this._assignment) throw new Error("Assignment not set");
    return this._assignment;
  }

  get isReady() {
    return !!this._assignment;
  }

  getReviewAssignmentRubricPartsController(
    review_assignment_id: number
  ): TableController<"review_assignment_rubric_parts"> {
    let controller = this._reviewAssignmentRubricPartsByReviewAssignmentId.get(review_assignment_id);
    if (!controller) {
      controller = new TableController({
        query: this._client
          .from("review_assignment_rubric_parts")
          .select("*")
          .eq("review_assignment_id", review_assignment_id),
        client: this._client,
        table: "review_assignment_rubric_parts",
        classRealTimeController: this._classRealTimeController,
        realtimeFilter: { review_assignment_id }
      });
      this._reviewAssignmentRubricPartsByReviewAssignmentId.set(review_assignment_id, controller);
    }
    const current = this._reviewAssignmentRubricPartsRefCount.get(review_assignment_id) ?? 0;
    this._reviewAssignmentRubricPartsRefCount.set(review_assignment_id, current + 1);
    return controller;
  }

  releaseReviewAssignmentRubricPartsController(review_assignment_id: number) {
    const current = this._reviewAssignmentRubricPartsRefCount.get(review_assignment_id) ?? 0;
    if (current <= 1) {
      const controller = this._reviewAssignmentRubricPartsByReviewAssignmentId.get(review_assignment_id);
      if (controller) {
        controller.close();
      }
      this._reviewAssignmentRubricPartsByReviewAssignmentId.delete(review_assignment_id);
      this._reviewAssignmentRubricPartsRefCount.delete(review_assignment_id);
    } else {
      this._reviewAssignmentRubricPartsRefCount.set(review_assignment_id, current - 1);
    }
  }
}

// --- Context ---

type AssignmentContextType = {
  assignmentController: AssignmentController;
};
export const AssignmentContext = createContext<AssignmentContextType | null>(null);
export function useAssignmentController() {
  const ctx = useContext(AssignmentContext);
  if (!ctx) throw new Error("useAssignmentController must be used within AssignmentProvider");
  return ctx.assignmentController;
}

// --- Provider ---

export function AssignmentProvider({
  assignment_id: initial_assignment_id,
  children,
  initialData
}: {
  assignment_id?: number;
  children: React.ReactNode;
  initialData?: AssignmentControllerInitialData;
}) {
  const params = useParams();
  const controller = useRef<AssignmentController | null>(null);
  const courseController = useCourseController();
  const [ready, setReady] = useState(false);
  const assignment_id = initial_assignment_id ?? Number(params.assignment_id);

  if (controller.current === null) {
    controller.current = new AssignmentController({
      client: createClient(),
      assignment_id: initial_assignment_id ?? Number(params.assignment_id),
      classRealTimeController: courseController.classRealTimeController,
      initialData
    });
    setReady(false);
  }
  useEffect(() => {
    return () => {
      if (controller.current) {
        controller.current.close();
        controller.current = null;
      }
    };
  }, []);

  if (!assignment_id || isNaN(assignment_id)) {
    return <Text>Error: Invalid Assignment ID.</Text>;
  }

  return (
    <AssignmentContext.Provider value={{ assignmentController: controller.current }}>
      <AssignmentControllerCreator assignment_id={assignment_id} setReady={setReady} controller={controller.current} />
      {ready && children}
    </AssignmentContext.Provider>
  );
}

/**
 * Loads assignment data, rubrics, and submissions into the provided AssignmentController and manages readiness state.
 *
 * Waits for assignment, rubrics, submissions, and required table controllers to be loaded before signaling readiness. Does not render any UI.
 *
 * @param assignment_id - The ID of the assignment to load
 * @param setReady - Callback to set readiness state when all data and controllers are loaded
 * @param controller - The AssignmentController instance to populate with loaded data
 */
function AssignmentControllerCreator({
  assignment_id,
  setReady,
  controller
}: {
  assignment_id: number;
  setReady: (ready: boolean) => void;
  controller: AssignmentController;
}) {
  const [tableControllersReady, setTableControllersReady] = useState(false);

  // Assignment base data (no nested rubrics)
  const { query: assignmentQuery } = useShow<AssignmentWithRubricsAndReferences>({
    resource: "assignments",
    id: assignment_id,
    queryOptions: { enabled: !!assignment_id },
    meta: {
      select: "*, assignment_self_review_settings(*)"
    }
  });

  // Wait for all table controllers to be ready
  useEffect(() => {
    const promises = [
      controller.reviewAssignments.readyPromise,
      controller.regradeRequests.readyPromise,
      controller.rubricsController.readyPromise,
      controller.rubricPartsController.readyPromise,
      controller.rubricCriteriaController.readyPromise,
      controller.rubricChecksController.readyPromise,
      controller.rubricCheckReferencesController.readyPromise,
      controller.submissions.readyPromise,
      controller.assignmentGroups.readyPromise
    ];
    Promise.all(promises).then(() => {
      setTableControllersReady(true);
    });
  }, [controller]);

  // Set assignment base data
  useEffect(() => {
    if (assignmentQuery.data?.data) {
      controller.assignment = assignmentQuery.data.data;
    }

    if (!assignmentQuery.isLoading && assignmentQuery.data?.data && tableControllersReady) {
      setReady(true);
    }
  }, [assignmentQuery.data, assignmentQuery.isLoading, controller, setReady, tableControllersReady]);

  return null;
}
