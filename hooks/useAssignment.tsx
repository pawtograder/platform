"use client";
import {
  ActiveSubmissionsWithGradesForAssignment,
  AssignmentGroup,
  AssignmentWithRubricsAndReferences,
  RegradeRequest,
  ReviewAssignmentParts,
  ReviewAssignments,
  RubricReviewRound,
  Submission
} from "@/utils/supabase/DatabaseTypes";

import { ClassRealTimeController } from "@/lib/ClassRealTimeController";
import TableController from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Text } from "@chakra-ui/react";
import { useShow } from "@refinedev/core";
import { SupabaseClient } from "@supabase/supabase-js";
import { useParams } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
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
  const [assignmentGroups, setAssignmentGroups] = useState<AssignmentGroup[]>(controller.assignmentGroups.rows);
  useEffect(() => {
    const { data, unsubscribe } = controller.assignmentGroups.list((data) => {
      setAssignmentGroups(data);
    });
    setAssignmentGroups(data);
    return () => unsubscribe();
  }, [controller]);
  return assignmentGroups;
}

export function useAssignmentGroup(assignment_group_id: number | null | undefined) {
  const controller = useAssignmentController();
  const [assignmentGroup, setAssignmentGroup] = useState<AssignmentGroup | undefined>(undefined);
  useEffect(() => {
    if (!assignment_group_id) {
      setAssignmentGroup(undefined);
      return;
    }
    const { data, unsubscribe } = controller.assignmentGroups.getById(assignment_group_id, (data) => {
      setAssignmentGroup(data);
    });
    setAssignmentGroup(data);
    return () => unsubscribe();
  }, [controller, assignment_group_id]);
  return assignmentGroup;
}

export function useSelfReviewSettings() {
  const controller = useAssignmentController();
  return controller.assignment.assignment_self_review_settings;
}

export function useRubricCheck(rubric_check_id: number | null | undefined) {
  const controller = useAssignmentController();
  if (!rubric_check_id) {
    return undefined;
  }
  const check = controller.rubricCheckById.get(rubric_check_id);
  if (!check) {
    return undefined;
  }
  const options = check.data instanceof Object && "options" in check.data ? check.data.options : [];
  return {
    ...check,
    options,
    criteria: controller.rubricCriteriaById.get(check.rubric_criteria_id)
  };
}

export function useRubricCriteria(rubric_criteria_id: number | null | undefined) {
  const controller = useAssignmentController();
  if (!rubric_criteria_id) {
    return undefined;
  }
  return controller.rubricCriteriaById.get(rubric_criteria_id);
}
export function useRubricById(rubric_id: number | undefined | null) {
  const controller = useAssignmentController();
  if (!rubric_id) {
    return undefined;
  }
  const rubrics = controller.rubrics;
  const rubric = rubrics.find((rubric) => rubric.id === rubric_id);
  return rubric;
}
export function useRubric(review_round: RubricReviewRound) {
  const controller = useAssignmentController();
  const rubrics = controller.rubrics;
  const rubric = rubrics.find((rubric) => rubric.review_round === review_round);
  return rubric;
}

export function useRubrics() {
  const controller = useAssignmentController();
  return controller.rubrics;
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
  const [reviewAssignments, setReviewAssignments] = useState<ReviewAssignments[]>(controller.reviewAssignments.rows);

  useEffect(() => {
    const { data, unsubscribe } = controller.reviewAssignments.list((data) => {
      setReviewAssignments(data);
    });
    setReviewAssignments(data);
    return () => unsubscribe();
  }, [controller]);

  const myReviewAssignments = useMemo(
    () =>
      reviewAssignments.filter(
        (ra) =>
          ra.assignee_profile_id === private_profile_id && (submission_id ? ra.submission_id === submission_id : true)
      ),
    [reviewAssignments, private_profile_id, submission_id]
  );
  return myReviewAssignments;
}

/**
 * Returns all rubric checks that reference the specified rubric check ID.
 *
 * @param rubric_check_id - The ID of the rubric check being referenced
 * @returns An array of referencing rubric checks, or undefined if no ID is provided
 */
export function useReferencingRubricChecks(rubric_check_id: number | null | undefined) {
  const controller = useAssignmentController();
  if (!rubric_check_id) {
    return undefined;
  }
  return controller.referencingChecksById.get(rubric_check_id);
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
  const [regradeRequests, setRegradeRequests] = useState<RegradeRequest[]>(controller.regradeRequests.rows);

  useEffect(() => {
    const { unsubscribe } = controller.regradeRequests.list(setRegradeRequests);
    setRegradeRequests(controller.regradeRequests.rows);
    return () => unsubscribe();
  }, [controller]);

  return regradeRequests;
}

/**
 * Subscribes to and returns a single regrade request by its ID, updating the value in real time as the data changes.
 *
 * @param regrade_request_id - The ID of the regrade request to retrieve, or `null`/`undefined` to disable the subscription.
 * @returns The regrade request with the specified ID, or `undefined` if not found or if the ID is not provided.
 */
export function useRegradeRequest(regrade_request_id: number | null | undefined) {
  const controller = useAssignmentController();
  const [regradeRequest, setRegradeRequest] = useState<RegradeRequest | undefined>(
    regrade_request_id ? controller.regradeRequests.rows.find((rr) => rr.id === regrade_request_id) : undefined
  );

  useEffect(() => {
    if (!regrade_request_id) {
      setRegradeRequest(undefined);
      return;
    }

    const { unsubscribe, data } = controller.regradeRequests.getById(regrade_request_id, setRegradeRequest);
    setRegradeRequest(data);
    return () => unsubscribe();
  }, [controller, regrade_request_id]);

  return regradeRequest;
}

/**
 * Returns all regrade requests associated with a specific submission.
 *
 * @param submission_id - The ID of the submission to filter regrade requests by
 * @returns An array of regrade requests for the given submission ID
 */
export function useRegradeRequestsBySubmission(submission_id: number | null | undefined) {
  const regradeRequests = useRegradeRequests();
  return useMemo(
    () => regradeRequests.filter((rr) => rr.submission_id === submission_id),
    [regradeRequests, submission_id]
  );
}

type OurRubricCheck =
  AssignmentWithRubricsAndReferences["rubrics"][number]["rubric_parts"][number]["rubric_criteria"][number]["rubric_checks"][number];
class AssignmentController {
  private _assignment?: AssignmentWithRubricsAndReferences;
  private _rubrics: AssignmentWithRubricsAndReferences["rubrics"] = [];
  private _submissions: ActiveSubmissionsWithGradesForAssignment[] = [];
  private _client: SupabaseClient<Database>;
  private _classRealTimeController: ClassRealTimeController;

  readonly reviewAssignments: TableController<"review_assignments">;
  readonly regradeRequests: TableController<"submission_regrade_requests">;
  readonly submissions: TableController<"submissions">;
  readonly assignmentGroups: TableController<"assignment_groups">;
  private _reviewAssignmentRubricPartsByReviewAssignmentId: Map<
    number,
    TableController<"review_assignment_rubric_parts">
  > = new Map();
  private _reviewAssignmentRubricPartsRefCount: Map<number, number> = new Map();

  rubricCheckById: Map<number, OurRubricCheck> = new Map();
  rubricCriteriaById: Map<
    number,
    AssignmentWithRubricsAndReferences["rubrics"][number]["rubric_parts"][number]["rubric_criteria"][number]
  > = new Map();
  referencingChecksById: Map<number, OurRubricCheck[]> = new Map();

  constructor({
    client,
    assignment_id,
    classRealTimeController
  }: {
    client: SupabaseClient<Database>;
    assignment_id: number;
    classRealTimeController: ClassRealTimeController;
  }) {
    this._client = client;
    this._classRealTimeController = classRealTimeController;
    this.autograder = new TableController({
      query: client.from("autograder").select("*").eq("id", assignment_id),
      client: client,
      table: "autograder",
      classRealTimeController
    });
    this.submissions = new TableController({
      query: client.from("submissions").select("*").eq("assignment_id", assignment_id).eq("is_active", true),
      client: client,
      table: "submissions",
      classRealTimeController
    });
    this.assignmentGroups = new TableController({
      query: client.from("assignment_groups").select("*").eq("assignment_id", assignment_id),
      client: client,
      table: "assignment_groups",
      classRealTimeController
    });
    this.reviewAssignments = new TableController({
      query: client.from("review_assignments").select("*").eq("assignment_id", assignment_id),
      client: client,
      table: "review_assignments",
      classRealTimeController
    });
    this.regradeRequests = new TableController({
      query: client.from("submission_regrade_requests").select("*").eq("assignment_id", assignment_id),
      client: client,
      table: "submission_regrade_requests",
      classRealTimeController
    });
  }
  close() {
    this.reviewAssignments.close();
    this.regradeRequests.close();
    this.submissions.close();
    this.assignmentGroups.close();
    for (const controller of this._reviewAssignmentRubricPartsByReviewAssignmentId.values()) {
      controller.close();
    }
    this._reviewAssignmentRubricPartsByReviewAssignmentId.clear();
  }
  // Assignment
  set assignment(assignment: AssignmentWithRubricsAndReferences) {
    if (this._assignment) {
      //TODO: refine.dev does a pretty bad job with invalidation on a complex query like this... but we never want it to be invalidated anyway I guess?
      return;
    }
    this._assignment = assignment;
  }
  get assignment() {
    if (!this._assignment) throw new Error("Assignment not set");
    return this._assignment;
  }

  // Rubrics
  set rubrics(rubrics: AssignmentWithRubricsAndReferences["rubrics"]) {
    this._rubrics = rubrics;
    this.rebuildRubricDerivedMaps();
  }
  get rubrics() {
    return this._rubrics;
  }
  private rebuildRubricDerivedMaps() {
    this.rubricCheckById.clear();
    this.rubricCriteriaById.clear();
    this.referencingChecksById.clear();
    for (const rubric of this._rubrics) {
      if (rubric.rubric_parts) {
        for (const part of rubric.rubric_parts) {
          if (part.rubric_criteria) {
            for (const criteria of part.rubric_criteria) {
              this.rubricCriteriaById.set(criteria.id, criteria);
              if (criteria.rubric_checks) {
                for (const check of criteria.rubric_checks) {
                  this.rubricCheckById.set(check.id, check);
                  if (check.rubric_check_references) {
                    for (const reference of check.rubric_check_references) {
                      if (!this.referencingChecksById.has(reference.referenced_rubric_check_id)) {
                        this.referencingChecksById.set(reference.referenced_rubric_check_id, []);
                      }
                      this.referencingChecksById
                        .get(reference.referenced_rubric_check_id)!
                        .push(this.rubricCheckById.get(reference.referencing_rubric_check_id)!);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  get isReady() {
    return !!this._assignment && this._rubrics.length > 0;
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
const AssignmentContext = createContext<AssignmentContextType | null>(null);
export function useAssignmentController() {
  const ctx = useContext(AssignmentContext);
  if (!ctx) throw new Error("useAssignmentController must be used within AssignmentProvider");
  return ctx.assignmentController;
}

// --- Provider ---

export function AssignmentProvider({
  assignment_id: initial_assignment_id,
  children
}: {
  assignment_id?: number;
  children: React.ReactNode;
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
      classRealTimeController: courseController.classRealTimeController
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
  // Assignment
  const { query: assignmentQuery } = useShow<AssignmentWithRubricsAndReferences>({
    resource: "assignments",
    id: assignment_id,
    queryOptions: { enabled: !!assignment_id },
    meta: {
      select:
        "*, assignment_self_review_settings(*), rubrics!rubrics_assignment_id_fkey(*, rubric_parts(*, rubric_criteria(*, rubric_checks(*, rubric_check_references!referencing_rubric_check_id(*)))))"
    }
  });

  useEffect(() => {
    const promises = [controller.reviewAssignments.readyPromise, controller.regradeRequests.readyPromise];
    Promise.all(promises).then(() => {
      setTableControllersReady(true);
    });
  }, [controller.reviewAssignments, controller.regradeRequests]);

  // Set data in controller
  useEffect(() => {
    if (assignmentQuery.data?.data) {
      controller.assignment = assignmentQuery.data.data;
      controller.rubrics = assignmentQuery.data.data.rubrics || [];
    }

    if (!assignmentQuery.isLoading && assignmentQuery.data?.data && tableControllersReady) {
      setReady(true);
    }
  }, [assignmentQuery.data, assignmentQuery.isLoading, controller, setReady, tableControllersReady]);

  return null;
}
