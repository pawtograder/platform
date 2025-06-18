import { Database } from "../../_shared/SupabaseTypes.d.ts";

export type GradebookColumnStudent = Database["public"]["Tables"]["gradebook_column_students"]["Row"];
export type SubmissionReview = Database["public"]["Tables"]["submission_reviews"]["Row"];
export type GradebookColumn = Database["public"]["Tables"]["gradebook_columns"]["Row"];
export type Assignment = Database["public"]["Tables"]["assignments"]["Row"];
