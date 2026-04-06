"use client";
import {
  AssignmentWithRubricsAndReferences,
  ReviewAssignmentParts,
  ReviewAssignments,
  RubricReviewRound,
  Submission
} from "@/utils/supabase/DatabaseTypes";

// AssignmentControllerInitialData is no longer needed — SSR data is delivered
// via TanStack Query's HydrationBoundary.
import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Text } from "@chakra-ui/react";
import { useShow } from "@refinedev/core";
import { SupabaseClient } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useClassProfiles } from "./useClassProfiles";
import { useCourseController } from "./useCourseController";
import {
  useSubmissionsQuery,
  useAssignmentScopedGroupsQuery,
  useReviewAssignmentsQuery,
  useRegradeRequestsQuery,
  useLeaderboardQuery,
  useRubricsQuery,
  useRubricPartsQuery,
  useRubricCriteriaQuery,
  useRubricChecksQuery,
  useRubricCheckReferencesQuery,
  useReviewAssignmentRubricPartsQuery
} from "@/hooks/assignment-data";

export function useSubmission(submission_id: number | null | undefined) {
  const { data } = useSubmissionsQuery();
  return useMemo(
    () => (submission_id ? (data ?? []).find((s) => s.id === submission_id) : undefined),
    [data, submission_id]
  ) as Submission | undefined;
}

export function useAssignmentGroups() {
  const { data } = useAssignmentScopedGroupsQuery();
  return data ?? [];
}

export function useAssignmentGroup(assignment_group_id: number | null | undefined) {
  const { data } = useAssignmentScopedGroupsQuery();
  return useMemo(
    () => (assignment_group_id ? (data ?? []).find((g) => g.id === assignment_group_id) : undefined),
    [data, assignment_group_id]
  );
}

export function useSelfReviewSettings() {
  const controller = useAssignmentController();
  return controller.assignment.assignment_self_review_settings;
}

/**
 * Returns whether grader pseudonymous mode is enabled for this assignment.
 * When enabled, graders' comments should use their public profile (pseudonym)
 * instead of their private profile (real name).
 */
export function useGraderPseudonymousMode() {
  const controller = useAssignmentController();
  return controller.assignment.grader_pseudonymous_mode || false;
}

export function useRubricCheck(rubric_check_id: number | null | undefined) {
  const { data } = useRubricChecksQuery();
  return useMemo(
    () => (rubric_check_id ? (data ?? []).find((c) => c.id === rubric_check_id) : undefined),
    [data, rubric_check_id]
  );
}

export function useRubricCriteria(rubric_criteria_id: number | null | undefined) {
  const { data } = useRubricCriteriaQuery();
  return useMemo(
    () => (rubric_criteria_id ? (data ?? []).find((c) => c.id === rubric_criteria_id) : undefined),
    [data, rubric_criteria_id]
  );
}
export function useRubricById(rubric_id: number | undefined | null) {
  const { data } = useRubricsQuery();
  return useMemo(() => (rubric_id ? (data ?? []).find((r) => r.id === rubric_id) : undefined), [data, rubric_id]);
}

/**
 * Returns a rubric with its parts populated (no deeper nesting)
 */
export function useRubricWithParts(rubric_id: number | null | undefined) {
  const rubric = useRubricById(rubric_id);
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
  const { data } = useRubricsQuery();
  return useMemo(() => (data ?? []).find((r) => r.review_round === review_round), [data, review_round]);
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
  const { data } = useRubricsQuery();
  return data ?? [];
}

/**
 * Returns all rubric parts for a specific rubric
 */
export function useRubricParts(rubric_id: number | null | undefined) {
  const { data } = useRubricPartsQuery();
  return useMemo(() => (rubric_id ? (data ?? []).filter((p) => p.rubric_id === rubric_id) : []), [data, rubric_id]);
}

/**
 * Returns all rubric criteria for a specific rubric
 */
export function useRubricCriteriaByRubric(rubric_id: number | null | undefined) {
  const { data } = useRubricCriteriaQuery();
  return useMemo(() => (rubric_id ? (data ?? []).filter((c) => c.rubric_id === rubric_id) : []), [data, rubric_id]);
}

/**
 * Returns all rubric checks for a specific rubric
 */
export function useRubricChecksByRubric(rubric_id: number | null | undefined) {
  const { data } = useRubricChecksQuery();
  return useMemo(() => (rubric_id ? (data ?? []).filter((c) => c.rubric_id === rubric_id) : []), [data, rubric_id]);
}

/**
 * Returns all rubric criteria for a specific rubric part
 */
export function useRubricCriteriaByPart(rubric_part_id: number | null | undefined) {
  const { data } = useRubricCriteriaQuery();
  return useMemo(
    () => (rubric_part_id ? (data ?? []).filter((c) => c.rubric_part_id === rubric_part_id) : []),
    [data, rubric_part_id]
  );
}

/**
 * Returns all rubric checks for a specific rubric criteria
 */
export function useRubricChecksByCriteria(rubric_criteria_id: number | null | undefined) {
  const { data } = useRubricChecksQuery();
  return useMemo(
    () => (rubric_criteria_id ? (data ?? []).filter((c) => c.rubric_criteria_id === rubric_criteria_id) : []),
    [data, rubric_criteria_id]
  );
}

/**
 * Returns all rubric checks for the assignment (not filtered by criteria)
 */
export function useAllRubricChecks() {
  const { data } = useRubricChecksQuery();
  return data ?? [];
}

export function useReviewAssignmentRubricParts(review_assignment_id: number | null | undefined) {
  const { data = [] } = useReviewAssignmentRubricPartsQuery(review_assignment_id ?? null);
  return data as unknown as ReviewAssignmentParts[];
}
export function useActiveSubmissions() {
  const { data } = useSubmissionsQuery();
  return (data ?? []) as Submission[];
}
export function useReviewAssignment(review_assignment_id: number | null | undefined) {
  const { data } = useReviewAssignmentsQuery();
  return useMemo(
    () => (review_assignment_id ? (data ?? []).find((ra) => ra.id === review_assignment_id) : undefined),
    [data, review_assignment_id]
  ) as ReviewAssignments | undefined;
}

export function useMyReviewAssignments(submission_id?: number) {
  const { data } = useReviewAssignmentsQuery();
  const { private_profile_id } = useClassProfiles();
  return useMemo(
    () =>
      (data ?? []).filter(
        (ra) =>
          ra.assignee_profile_id === private_profile_id && (submission_id ? ra.submission_id === submission_id : true)
      ),
    [data, private_profile_id, submission_id]
  );
}

/**
 * Returns all rubric checks that reference the specified rubric check ID.
 *
 * @param rubric_check_id - The ID of the rubric check being referenced
 * @returns An array of referencing rubric checks, or undefined if no ID is provided
 */
export function useReferencingRubricChecks(rubric_check_id: number | null | undefined) {
  const { data } = useRubricCheckReferencesQuery();
  return useMemo(
    () => (rubric_check_id ? (data ?? []).filter((ref) => ref.referencing_rubric_check_id === rubric_check_id) : []),
    [data, rubric_check_id]
  );
}

export function useReferenceCheckRecordsFromCheck(rubric_check_id: number | null | undefined) {
  const { data } = useRubricCheckReferencesQuery();
  return useMemo(
    () => (rubric_check_id ? (data ?? []).filter((ref) => ref.referencing_rubric_check_id === rubric_check_id) : []),
    [data, rubric_check_id]
  );
}

export function useReferencedRubricChecks(rubric_check_id: number | null | undefined) {
  const { data: refs } = useRubricCheckReferencesQuery();
  const { data: checks } = useRubricChecksQuery();
  return useMemo(() => {
    if (!rubric_check_id) return [];
    const referencedIds = new Set(
      (refs ?? [])
        .filter((ref) => ref.referencing_rubric_check_id === rubric_check_id)
        .map((ref) => ref.referenced_rubric_check_id)
    );
    return (checks ?? []).filter((c) => referencedIds.has(c.id));
  }, [refs, checks, rubric_check_id]);
}
/**
 * Subscribes to and returns all regrade requests for the current assignment.
 *
 * The returned array updates in real time as regrade requests are added, modified, or removed.
 *
 * @returns An array of regrade requests associated with the current assignment.
 */
export function useRegradeRequests() {
  const { data } = useRegradeRequestsQuery();
  return data ?? [];
}

/**
 * Subscribes to and returns a single regrade request by its ID, updating the value in real time as the data changes.
 *
 * @param regrade_request_id - The ID of the regrade request to retrieve, or `null`/`undefined` to disable the subscription.
 * @returns The regrade request with the specified ID, or `undefined` if not found or if the ID is not provided.
 */
export function useRegradeRequest(regrade_request_id: number | null | undefined) {
  const { data } = useRegradeRequestsQuery();
  return useMemo(
    () => (regrade_request_id ? (data ?? []).find((r) => r.id === regrade_request_id) : undefined),
    [data, regrade_request_id]
  );
}

/**
 * Returns all regrade requests associated with a specific submission.
 *
 * @param submission_id - The ID of the submission to filter regrade requests by
 * @returns An array of regrade requests for the given submission ID
 */
export function useRegradeRequestsBySubmission(submission_id: number | null | undefined) {
  const { data } = useRegradeRequestsQuery();
  return useMemo(
    () => (submission_id ? (data ?? []).filter((r) => r.submission_id === submission_id) : []),
    [data, submission_id]
  );
}

/**
 * Returns all leaderboard entries for the current assignment, sorted by autograder score descending.
 * Uses the TableController for real-time updates.
 */
export function useLeaderboard() {
  const { data } = useLeaderboardQuery();
  return data ?? [];
}

/**
 * Returns a single leaderboard entry by its ID.
 */
export function useLeaderboardEntry(id: number | null | undefined) {
  const { data } = useLeaderboardQuery();
  return useMemo(() => (id ? (data ?? []).find((e) => e.id === id) : undefined), [data, id]);
}

/**
 * Lightweight adapter providing the same mutation API as the old
 * TableController-based shims. No realtime subscriptions; data flows
 * through TanStack Query hooks in assignment-data/.
 */
function makeAssignmentTableShim<TableName extends keyof Database["public"]["Tables"]>(
  client: SupabaseClient<Database>,
  table: TableName,
  queryKey: readonly unknown[]
) {
  type Row = Database["public"]["Tables"][TableName]["Row"];
  type Insert = Database["public"]["Tables"][TableName]["Insert"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = client as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _queryClient: any = null;

  return {
    _setQueryClient(qc: unknown) {
      _queryClient = qc;
    },
    /** Cached rows — reads from TanStack Query cache. */
    get rows(): Row[] {
      return (_queryClient?.getQueryData?.(queryKey) ?? []) as Row[];
    },
    _setRows(_rows: Row[]) {
      // No-op: data lives in TanStack Query cache.
    },
    async create(row: Insert): Promise<Row> {
      const { data, error } = await db.from(table).insert(row).select("*").single();
      if (error) throw error;
      _queryClient?.invalidateQueries?.({ queryKey });
      return data as Row;
    },
    async update(id: number | string, values: Partial<Row>): Promise<Row> {
      const { data, error } = await db.from(table).update(values).eq("id", id).select("*").single();
      if (error) throw error;
      _queryClient?.invalidateQueries?.({ queryKey });
      return data as Row;
    },
    async delete(id: number | string): Promise<void> {
      const { error } = await db.from(table).update({ deleted_at: new Date().toISOString() }).eq("id", id);
      if (error) throw error;
      _queryClient?.invalidateQueries?.({ queryKey });
    },
    async hardDelete(id: number | string): Promise<void> {
      const { error } = await db.from(table).delete().eq("id", id);
      if (error) throw error;
      _queryClient?.invalidateQueries?.({ queryKey });
    },
    async invalidate(id?: number | string): Promise<void> {
      _queryClient?.invalidateQueries?.({ queryKey });
    },
    async refetchAll(): Promise<void> {
      _queryClient?.invalidateQueries?.({ queryKey });
    },
    /** Compatibility: return all rows and an unsubscribe no-op. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    list(callback?: (data: Row[], params: any) => void): { data: Row[]; unsubscribe: () => void } {
      if (callback) callback(this.rows, { entered: [], left: [] });
      return { data: this.rows, unsubscribe: () => {} };
    },
    /** Compatibility: find a row by id. */
    getById(
      id: number,
      callback?: (data: Row | undefined) => void
    ): { data: Row | undefined; unsubscribe: () => void } {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const found = this.rows.find((r: any) => r.id === id);
      if (callback) callback(found);
      return { data: found, unsubscribe: () => {} };
    },
    readyPromise: Promise.resolve(),
    close() {
      // No-op — no subscriptions to tear down.
    }
  };
}

type AssignmentTableShim<T extends keyof Database["public"]["Tables"]> = ReturnType<typeof makeAssignmentTableShim<T>>;

export class AssignmentController {
  private _assignment?: AssignmentWithRubricsAndReferences;
  private _client: SupabaseClient<Database>;

  readonly reviewAssignments: AssignmentTableShim<"review_assignments">;
  readonly regradeRequests: AssignmentTableShim<"submission_regrade_requests">;
  readonly submissions: AssignmentTableShim<"submissions">;
  readonly assignmentGroups: AssignmentTableShim<"assignment_groups">;
  readonly leaderboard: AssignmentTableShim<"assignment_leaderboard">;

  // Rubric table shims
  readonly rubricsController: AssignmentTableShim<"rubrics">;
  readonly rubricPartsController: AssignmentTableShim<"rubric_parts">;
  readonly rubricCriteriaController: AssignmentTableShim<"rubric_criteria">;
  readonly rubricChecksController: AssignmentTableShim<"rubric_checks">;
  readonly rubricCheckReferencesController: AssignmentTableShim<"rubric_check_references">;

  // Error pin table shims
  readonly errorPins: AssignmentTableShim<"error_pins">;
  readonly errorPinRules: AssignmentTableShim<"error_pin_rules">;

  constructor({
    client,
    assignment_id,
    courseId
  }: {
    client: SupabaseClient<Database>;
    assignment_id: number;
    courseId: number;
  }) {
    this._client = client;
    const ck = (suffix: string) => ["course", courseId, "assignment", assignment_id, suffix] as const;

    this.submissions = makeAssignmentTableShim(client, "submissions", ck("submissions"));
    this.assignmentGroups = makeAssignmentTableShim(client, "assignment_groups", ck("assignment_groups"));
    this.reviewAssignments = makeAssignmentTableShim(client, "review_assignments", ck("review_assignments"));
    this.regradeRequests = makeAssignmentTableShim(client, "submission_regrade_requests", ck("regrade_requests"));
    this.leaderboard = makeAssignmentTableShim(client, "assignment_leaderboard", ck("leaderboard"));

    this.rubricsController = makeAssignmentTableShim(client, "rubrics", ck("rubrics"));
    this.rubricPartsController = makeAssignmentTableShim(client, "rubric_parts", ck("rubric_parts"));
    this.rubricCriteriaController = makeAssignmentTableShim(client, "rubric_criteria", ck("rubric_criteria"));
    this.rubricChecksController = makeAssignmentTableShim(client, "rubric_checks", ck("rubric_checks"));
    this.rubricCheckReferencesController = makeAssignmentTableShim(
      client,
      "rubric_check_references",
      ck("rubric_check_references")
    );
    this.errorPins = makeAssignmentTableShim(client, "error_pins", ck("error_pins"));
    this.errorPinRules = makeAssignmentTableShim(client, "error_pin_rules", ck("error_pin_rules"));
  }

  /** Inject the QueryClient so shims can invalidate TanStack caches. */
  _setQueryClient(qc: unknown) {
    this.reviewAssignments._setQueryClient(qc);
    this.regradeRequests._setQueryClient(qc);
    this.submissions._setQueryClient(qc);
    this.assignmentGroups._setQueryClient(qc);
    this.leaderboard._setQueryClient(qc);
    this.rubricsController._setQueryClient(qc);
    this.rubricPartsController._setQueryClient(qc);
    this.rubricCriteriaController._setQueryClient(qc);
    this.rubricChecksController._setQueryClient(qc);
    this.rubricCheckReferencesController._setQueryClient(qc);
    this.errorPins._setQueryClient(qc);
    this.errorPinRules._setQueryClient(qc);
  }

  close() {
    // No subscriptions to tear down.
  }

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

/**
 * Returns the current assignment data from the AssignmentController.
 * This hook provides access to assignment properties like release_date, regrade_deadlin, etc.
 */
export function useAssignmentData() {
  const controller = useAssignmentController();
  return controller.assignment;
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
  const courseController = useCourseController();
  const queryClient = useQueryClient();
  const controllerRef = useRef<AssignmentController | null>(null);
  const [ready, setReady] = useState(false);
  const assignment_id = initial_assignment_id ?? Number(params.assignment_id);
  const course_id = Number(params.course_id);

  if (controllerRef.current === null) {
    controllerRef.current = new AssignmentController({
      client: createClient(),
      assignment_id,
      courseId: course_id
    });
    setReady(false);
  }
  const controller = controllerRef.current;

  // Inject QueryClient so shims can invalidate TanStack caches
  controller._setQueryClient(queryClient);

  if (!assignment_id || isNaN(assignment_id)) {
    return <Text>Error: Invalid Assignment ID.</Text>;
  }

  return (
    <AssignmentContext.Provider value={{ assignmentController: controller }}>
      <AssignmentControllerCreator assignment_id={assignment_id} setReady={setReady} controller={controller} />
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
  // Assignment base data (no nested rubrics)
  const { query: assignmentQuery } = useShow<AssignmentWithRubricsAndReferences>({
    resource: "assignments",
    id: assignment_id,
    queryOptions: { enabled: !!assignment_id },
    meta: {
      select: "*, assignment_self_review_settings(*)"
    }
  });

  // Set assignment base data and signal ready
  useEffect(() => {
    if (assignmentQuery.data?.data) {
      controller.assignment = assignmentQuery.data.data;
    }

    if (!assignmentQuery.isLoading && assignmentQuery.data?.data) {
      setReady(true);
    }
  }, [assignmentQuery.data, assignmentQuery.isLoading, controller, setReady]);

  return null;
}
