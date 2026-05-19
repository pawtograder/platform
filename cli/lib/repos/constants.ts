export const GRADE_WORKFLOW_PATH = ".github/workflows/grade.yml";

export function handoutLocalDir(assignmentId: number): string {
  return `__handout_${assignmentId}`;
}
