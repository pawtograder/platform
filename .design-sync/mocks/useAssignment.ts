/* eslint-disable @typescript-eslint/no-explicit-any */
import { mockTable } from "./_lib";
import { assignment, rubric, rubricParts, rubricCriteria, rubricChecks } from "./fixtures";

const assignmentController: any = {
  assignment,
  submissions: mockTable([]),
  rubrics: mockTable([rubric]),
  rubricParts: mockTable(rubricParts),
  rubricCriteria: mockTable(rubricCriteria),
  rubricChecks: mockTable(rubricChecks),
  rubricsController: mockTable([rubric]),
  rubricPartsController: mockTable(rubricParts),
  isReady: true
};

export function useAssignmentController(): any { return assignmentController; }
export function useAssignment(): any { return assignment; }
export function useAssignmentData(): any { return { assignment }; }
export function useGraderPseudonymousMode(): boolean { return false; }
export function useSelfReviewSettings(): any { return { enabled: false }; }

export function useRubrics(): any[] { return [rubric]; }
export function useRubric(): any { return rubric; }
export function useRubricById(): any { return rubric; }
export function useRubricWithParts(): any { return { ...rubric, rubric_parts: rubricParts }; }
export function useRubricParts(): any[] { return rubricParts; }
export function useRubricCriteriaByPart(part_id?: any): any[] {
  return rubricCriteria.filter((c) => c.rubric_part_id === part_id);
}
export function useRubricCriteriaByRubric(): any[] { return rubricCriteria; }
export function useRubricCriteria(id?: any): any { return rubricCriteria.find((c) => c.id === id) ?? rubricCriteria[0]; }
export function useRubricChecksByCriteria(criteria_id?: any): any[] {
  return rubricChecks.filter((c) => c.rubric_criteria_id === criteria_id);
}
export function useRubricChecksByRubric(): any[] { return rubricChecks; }
export function useRubricCheck(id?: any): any { return rubricChecks.find((c) => c.id === id) ?? rubricChecks[0]; }

export function useReviewAssignment(): any { return undefined; }
export function useReviewAssignmentRubricParts(): any[] { return []; }
export function useMyReviewAssignments(): any[] { return []; }
export function useActiveSubmissions(): any[] { return []; }
export function useAssignmentGroups(): any[] { return []; }
export function useLeaderboard(): any { return { entries: [] }; }
export function useRegradeRequest(): any { return undefined; }
export function useBareCheckRegradeRequest(): any { return undefined; }

// ── added safe defaults (repo-wide importers) ──
export function useSubmission(): any { return undefined; }
export function useAllRubricChecks(): any[] { return rubricChecks; }
export function useAssignmentGroup(): any { return undefined; }
export function useRegradeRequestsBySubmission(): any[] { return []; }
