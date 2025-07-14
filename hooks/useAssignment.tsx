"use client";
import {
  ActiveSubmissionsWithGradesForAssignment,
  AssignmentWithRubricsAndReferences,
  ReviewAssignmentParts,
  ReviewAssignments,
  RubricReviewRound
} from "@/utils/supabase/DatabaseTypes";
import { Text } from "@chakra-ui/react";
import { useList, useShow } from "@refinedev/core";
import { useParams } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useClassProfiles } from "./useClassProfiles";
import TableController from "@/lib/TableController";
import { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { ClassRealTimeController } from "@/lib/ClassRealTimeController";
import { useCourseController } from "./useCourseController";
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
  const [reviewAssignmentRubricParts, setReviewAssignmentRubricParts] = useState<ReviewAssignmentParts[]>([]);
  useEffect(() => {
    const { data, unsubscribe } = controller.reviewAssignmentRubricParts.list((data) => {
      setReviewAssignmentRubricParts(data);
    });
    setReviewAssignmentRubricParts(data ?? []);
    return () => unsubscribe();
  }, [controller]);
  const filteredParts = useMemo(() => {
    return reviewAssignmentRubricParts.filter((part) => part.review_assignment_id === review_assignment_id);
  }, [reviewAssignmentRubricParts, review_assignment_id]);
  return filteredParts;
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

type OurRubricCheck =
  AssignmentWithRubricsAndReferences["rubrics"][number]["rubric_parts"][number]["rubric_criteria"][number]["rubric_checks"][number];
class AssignmentController {
  private _assignment?: AssignmentWithRubricsAndReferences;
  private _rubrics: AssignmentWithRubricsAndReferences["rubrics"] = [];
  private _submissions: ActiveSubmissionsWithGradesForAssignment[] = [];

  readonly reviewAssignments: TableController<"review_assignments">;
  readonly reviewAssignmentRubricParts: TableController<"review_assignment_rubric_parts">;

  rubricCheckById: Map<number, OurRubricCheck> = new Map();
  rubricCriteriaById: Map<
    number,
    AssignmentWithRubricsAndReferences["rubrics"][number]["rubric_parts"][number]["rubric_criteria"][number]
  > = new Map();
  referencingChecksById: Map<number, OurRubricCheck[]> = new Map();

  constructor({
    client,
    assignment_id,
    class_id,
    classRealTimeController
  }: {
    client: SupabaseClient<Database>;
    assignment_id: number;
    class_id: number;
    classRealTimeController: ClassRealTimeController;
  }) {
    this.reviewAssignments = new TableController({
      query: client.from("review_assignments").select("*").eq("assignment_id", assignment_id),
      client: client,
      table: "review_assignments",
      classRealTimeController
    });
    this.reviewAssignmentRubricParts = new TableController({
      query: client.from("review_assignment_rubric_parts").select("*").eq("class_id", class_id),
      client: client,
      table: "review_assignment_rubric_parts",
      classRealTimeController
    });
  }
  close() {
    this.reviewAssignments.close();
    this.reviewAssignmentRubricParts.close();
  }
  // Assignment
  set assignment(assignment: AssignmentWithRubricsAndReferences) {
    console.log("Setting assignment", assignment);
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
  // Submissions
  set submissions(submissions: ActiveSubmissionsWithGradesForAssignment[]) {
    this._submissions = submissions;
  }
  get submissions() {
    return this._submissions;
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
  const controller = useRef<AssignmentController | null>(null);
  const courseController = useCourseController();
  const [ready, setReady] = useState(false);
  const assignment_id = initial_assignment_id ?? Number(params.assignment_id);

  if (controller.current === null) {
    controller.current = new AssignmentController({
      client: createClient(),
      assignment_id: initial_assignment_id ?? Number(params.assignment_id),
      class_id: Number(params.course_id),
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

  // Submissions (minimal info)
  const { data: submissionsData } = useList<ActiveSubmissionsWithGradesForAssignment>({
    resource: "submissions_with_grades_for_assignment",
    filters: [{ field: "assignment_id", operator: "eq", value: assignment_id }],
    pagination: { pageSize: 1000 },
    queryOptions: { enabled: !!assignment_id }
  });

  useEffect(() => {
    controller.reviewAssignments.readyPromise.then(() => {
      setTableControllersReady(true);
    });
  }, [controller.reviewAssignments]);

  // Set data in controller
  useEffect(() => {
    if (assignmentQuery.data?.data) {
      controller.assignment = assignmentQuery.data.data;
    }
    controller.rubrics = assignmentQuery.data?.data.rubrics || [];
    if (submissionsData?.data) {
      controller.submissions = submissionsData.data;
    }
    if (!assignmentQuery.isLoading && assignmentQuery.data?.data && tableControllersReady) {
      console.log("Setting ready to true");
      console.log(assignmentQuery.data.data);
      console.log(controller.assignment);
      setReady(true);
    }
  }, [assignmentQuery.data, assignmentQuery.isLoading, submissionsData, controller, setReady, tableControllersReady]);

  return null;
}
