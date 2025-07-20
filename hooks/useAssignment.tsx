"use client";
import {
  ActiveSubmissionsWithGradesForAssignment,
  AssignmentWithRubricsAndReferences,
  RegradeRequest,
  RubricReviewRound
} from "@/utils/supabase/DatabaseTypes";

import { Text } from "@chakra-ui/react";
import { LiveEvent, useList, useShow } from "@refinedev/core";
import { useParams } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useClassProfiles } from "./useClassProfiles";

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

export function useReviewAssignment(review_assignment_id: number | null | undefined) {
  const controller = useAssignmentController();
  if (!review_assignment_id) {
    return undefined;
  }
  const assignments = controller.getReviewAssignments().data;
  return assignments.find((ra) => ra.id === review_assignment_id);
}

export function useMyReviewAssignments(submission_id?: number) {
  const controller = useAssignmentController();
  const { private_profile_id } = useClassProfiles();
  const [reviewAssignments, setReviewAssignments] = useState<AssignmentWithRubricsAndReferences["review_assignments"]>(
    []
  );
  useEffect(() => {
    const { unsubscribe, data } = controller.getReviewAssignments(setReviewAssignments);
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
 * Returns all referencing rubric checks for which the given check is the referenced check.
 * @param rubric_check_id Check that is referenced
 * @returns the referencing rubric checks
 */
export function useReferencingRubricChecks(rubric_check_id: number | null | undefined) {
  const controller = useAssignmentController();
  if (!rubric_check_id) {
    return undefined;
  }
  return controller.referencingChecksById.get(rubric_check_id);
}

export function useRegradeRequests() {
  const controller = useAssignmentController();
  const [regradeRequests, setRegradeRequests] = useState<RegradeRequest[]>(controller.regradeRequests);
  
  useEffect(() => {
    const { unsubscribe } = controller.getRegradeRequests(setRegradeRequests);
    setRegradeRequests(controller.regradeRequests);
    return () => unsubscribe();
  }, [controller]);
  
  return regradeRequests;
}

export function useRegradeRequest(regrade_request_id: number | null | undefined) {
  const controller = useAssignmentController();
  const [regradeRequest, setRegradeRequest] = useState<RegradeRequest | undefined>(regrade_request_id ? controller.regradeRequests.find((rr) => rr.id === regrade_request_id) : undefined);
  
  useEffect(() => {
    if (!regrade_request_id) {
      setRegradeRequest(undefined);
      return;
    }
    
    const { unsubscribe, data } = controller.getRegradeRequest(regrade_request_id, setRegradeRequest);
    setRegradeRequest(data);
    return () => unsubscribe();
  }, [controller, regrade_request_id]);
  
  return regradeRequest;
}

export function useRegradeRequestsBySubmission(submission_id: number | null | undefined) {
  const regradeRequests = useRegradeRequests();
  return useMemo(() => regradeRequests.filter((rr) => rr.submission_id === submission_id), [regradeRequests, submission_id]);
}

type OurRubricCheck =
  AssignmentWithRubricsAndReferences["rubrics"][number]["rubric_parts"][number]["rubric_criteria"][number]["rubric_checks"][number];
class AssignmentController {
  private _assignment?: AssignmentWithRubricsAndReferences;
  private _rubrics: AssignmentWithRubricsAndReferences["rubrics"] = [];
  private _submissions: ActiveSubmissionsWithGradesForAssignment[] = [];

  private _reviewAssignments: AssignmentWithRubricsAndReferences["review_assignments"] = [];
  private _reviewAssignmentListSubscribers: ((
    reviewAssignments: AssignmentWithRubricsAndReferences["review_assignments"]
  ) => void)[] = [];

  private _regradeRequests: RegradeRequest[] = [];
  private _regradeRequestListSubscribers: ((regradeRequests: RegradeRequest[]) => void)[] = [];
  private _regradeRequestByIdSubscribers: Map<number, ((regradeRequest: RegradeRequest | undefined) => void)[]> = new Map();

  rubricCheckById: Map<number, OurRubricCheck> = new Map();
  rubricCriteriaById: Map<
    number,
    AssignmentWithRubricsAndReferences["rubrics"][number]["rubric_parts"][number]["rubric_criteria"][number]
  > = new Map();
  referencingChecksById: Map<number, OurRubricCheck[]> = new Map();

  // Assignment
  set assignment(assignment: AssignmentWithRubricsAndReferences) {
    this._assignment = assignment;
    this._reviewAssignments = assignment.review_assignments;
  }
  get assignment() {
    if (!this._assignment) throw new Error("Assignment not set");
    return this._assignment;
  }
  getReviewAssignments(
    callback?: (reviewAssignments: AssignmentWithRubricsAndReferences["review_assignments"]) => void
  ) {
    if (callback) {
      this._reviewAssignmentListSubscribers.push(callback);
    }
    return {
      unsubscribe: () => {
        this._reviewAssignmentListSubscribers = this._reviewAssignmentListSubscribers.filter((cb) => cb !== callback);
      },
      data: this._reviewAssignments
    };
  }

  getRegradeRequests(callback?: (regradeRequests: RegradeRequest[]) => void) {
    if (callback) {
      this._regradeRequestListSubscribers.push(callback);
    }
    return {
      unsubscribe: () => {
        this._regradeRequestListSubscribers = this._regradeRequestListSubscribers.filter((cb) => cb !== callback);
      },
      data: this._regradeRequests
    };
  }

  getRegradeRequest(
    regradeRequestId: number,
    callback?: (regradeRequest: RegradeRequest | undefined) => void
  ) {
    if (callback) {
      if (!this._regradeRequestByIdSubscribers.has(regradeRequestId)) {
        this._regradeRequestByIdSubscribers.set(regradeRequestId, []);
      }
      this._regradeRequestByIdSubscribers.get(regradeRequestId)!.push(callback);
    }
    return {
      unsubscribe: () => {
        if (callback) {
          const subscribers = this._regradeRequestByIdSubscribers.get(regradeRequestId);
          if (subscribers) {
            const filtered = subscribers.filter((cb) => cb !== callback);
            if (filtered.length === 0) {
              this._regradeRequestByIdSubscribers.delete(regradeRequestId);
            } else {
              this._regradeRequestByIdSubscribers.set(regradeRequestId, filtered);
            }
          }
        }
      },
      data: this._regradeRequests.find((rr) => rr.id === regradeRequestId)
    };
  }

  handleReviewAssignmentEvent(event: LiveEvent) {
    const body = event.payload as AssignmentWithRubricsAndReferences["review_assignments"][number]; // Assertion for event.payload
    const id = body.id;
    if (event.type === "created") {
      this._reviewAssignments = [...this._reviewAssignments, body];
      this._reviewAssignmentListSubscribers.forEach((cb) => cb(this._reviewAssignments));
    } else if (event.type === "updated") {
      const index = this._reviewAssignments.findIndex((ra) => ra.id === id);
      if (index !== -1) {
        this._reviewAssignments = this._reviewAssignments.map((ra) => (ra.id === id ? body : ra));
        this._reviewAssignmentListSubscribers.forEach((cb) => cb(this._reviewAssignments));
      }
    }
  }

  handleRegradeRequestEvent(event: LiveEvent) {
    const body = event.payload as RegradeRequest; // Assertion for event.payload
    const id = body.id;
    console.log("handleRegradeRequestEvent", event.type, body);
    
    if (event.type === "created") {
      this._regradeRequests = [...this._regradeRequests, body];
      this._regradeRequestListSubscribers.forEach((cb) => cb(this._regradeRequests));
      // Notify individual subscribers for this specific regrade request
      const idSubscribers = this._regradeRequestByIdSubscribers.get(id);
      if (idSubscribers) {
        idSubscribers.forEach((cb) => cb(body));
      }
    } else if (event.type === "updated") {
      const index = this._regradeRequests.findIndex((rr) => rr.id === id);
      if (index !== -1) {
        this._regradeRequests = this._regradeRequests.map((rr) => (rr.id === id ? body : rr));
        this._regradeRequestListSubscribers.forEach((cb) => cb(this._regradeRequests));
        // Notify individual subscribers for this specific regrade request
        const idSubscribers = this._regradeRequestByIdSubscribers.get(id);
        if (idSubscribers) {
          idSubscribers.forEach((cb) => cb(body));
        }
      }
    } else if (event.type === "deleted") {
      this._regradeRequests = this._regradeRequests.filter((rr) => rr.id !== id);
      this._regradeRequestListSubscribers.forEach((cb) => cb(this._regradeRequests));
      // Notify individual subscribers for this specific regrade request
      const idSubscribers = this._regradeRequestByIdSubscribers.get(id);
      if (idSubscribers) {
        idSubscribers.forEach((cb) => cb(undefined));
      }
    }
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
  // Submissions
  set submissions(submissions: ActiveSubmissionsWithGradesForAssignment[]) {
    this._submissions = submissions;
  }
  get submissions() {
    return this._submissions;
  }
  // Regrade Requests
  set regradeRequests(regradeRequests: RegradeRequest[]) {
    this._regradeRequests = regradeRequests;
  }
  get regradeRequests() {
    return this._regradeRequests;
  }
  get isReady() {
    return !!this._assignment && this._rubrics.length > 0;
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
  const controller = useRef<AssignmentController>(new AssignmentController());
  const [ready, setReady] = useState(false);
  const assignment_id = initial_assignment_id ?? Number(params.assignment_id);

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

function AssignmentControllerCreator({
  assignment_id,
  setReady,
  controller
}: {
  assignment_id: number;
  setReady: (ready: boolean) => void;
  controller: AssignmentController;
}) {
  // Assignment
  const { query: assignmentQuery } = useShow<AssignmentWithRubricsAndReferences>({
    resource: "assignments",
    id: assignment_id,
    queryOptions: { enabled: !!assignment_id },
    meta: {
      select:
        "*, assignment_self_review_settings(*), review_assignments!review_assignments_assignment_id_fkey(*, review_assignment_rubric_parts(*)), rubrics!rubrics_assignment_id_fkey(*, rubric_parts(*, rubric_criteria(*, rubric_checks(*, rubric_check_references!referencing_rubric_check_id(*)))))"
    }
  });

  // Submissions (minimal info)
  const { data: submissionsData } = useList<ActiveSubmissionsWithGradesForAssignment>({
    resource: "submissions_with_grades_for_assignment",
    filters: [{ field: "assignment_id", operator: "eq", value: assignment_id }],
    pagination: { pageSize: 1000 },
    queryOptions: { enabled: !!assignment_id }
  });

  // Review Assignments
  useList<AssignmentWithRubricsAndReferences["review_assignments"][number]>({
    resource: "review_assignments",
    filters: [{ field: "assignment_id", operator: "eq", value: assignment_id }],
    pagination: { pageSize: 1000 },
    queryOptions: { enabled: !!assignment_id },
    liveMode: "manual",
    onLiveEvent: (event) => {
      controller.handleReviewAssignmentEvent(event);
    }
  });

  // Regrade Requests with pagination to fetch all data
  const [regradeRequestsData, setRegradeRequestsData] = useState<RegradeRequest[]>([]);
  const [regradeRequestsLoading, setRegradeRequestsLoading] = useState(false);
  const [regradeRequestsPage, setRegradeRequestsPage] = useState(1);
  const [regradeRequestsHasMore, setRegradeRequestsHasMore] = useState(true);
  
  const { data: currentRegradeRequestsData, isLoading: isCurrentRegradeRequestsLoading } = useList<RegradeRequest>({
    resource: "submission_regrade_requests",
    filters: [{ field: "assignment_id", operator: "eq", value: assignment_id }],
    pagination: { current: regradeRequestsPage, pageSize: 1000 },
    queryOptions: { enabled: true },
    liveMode: "manual",
    onLiveEvent: (event) => {
      controller.handleRegradeRequestEvent(event);
    }
  });

  // Handle pagination for regrade requests
  useEffect(() => {
    if (currentRegradeRequestsData?.data && !isCurrentRegradeRequestsLoading) {
      const newData = currentRegradeRequestsData.data;
      console.log("newData", newData);
      console.log("regradeRequestsPage", regradeRequestsPage);
      if (regradeRequestsPage === 1) {
        setRegradeRequestsData(newData);
      } else {
        setRegradeRequestsData(prev => [...prev, ...newData]);
      }
      
      // Check if we have more data to fetch
      if (newData.length < 1000) {
        setRegradeRequestsHasMore(false);
      } else {
        setRegradeRequestsPage(prev => prev + 1);
      }
    }
  }, [currentRegradeRequestsData, isCurrentRegradeRequestsLoading, regradeRequestsPage]);

  // Update loading state
  useEffect(() => {
    setRegradeRequestsLoading(isCurrentRegradeRequestsLoading && regradeRequestsHasMore);
  }, [isCurrentRegradeRequestsLoading, regradeRequestsHasMore]);

  // Set data in controller
  useEffect(() => {
    if (assignmentQuery.data?.data) {
      controller.assignment = assignmentQuery.data.data;
    }
    controller.rubrics = assignmentQuery.data?.data.rubrics || [];
    if (submissionsData?.data) {
      controller.submissions = submissionsData.data;
    }
    controller.regradeRequests = regradeRequestsData;
    if (!assignmentQuery.isLoading && assignmentQuery.data?.data && !regradeRequestsLoading) {
      setReady(true);
    }
  }, [assignmentQuery.data, assignmentQuery.isLoading, submissionsData, regradeRequestsData, regradeRequestsLoading, controller, setReady]);

  return null;
}
