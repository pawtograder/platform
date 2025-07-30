import { Database } from "../../_shared/SupabaseTypes.d.ts";

export type GradebookColumnStudent = Database["public"]["Tables"]["gradebook_column_students"]["Row"];
export type GradebookColumnStudentWithMaxScore = Omit<GradebookColumnStudent, "score"> & {
  score: number;
  max_score: number;
  column_slug: string;
};
export type SubmissionReview = Database["public"]["Tables"]["submission_reviews"]["Row"];
export type GradebookColumn = Database["public"]["Tables"]["gradebook_columns"]["Row"];
export type Assignment = Database["public"]["Tables"]["assignments"]["Row"];
export type SubmissionWithGradesForAssignment =
  Database["public"]["Views"]["submissions_with_grades_for_assignment"]["Row"];
