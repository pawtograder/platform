// Canned grading data for the design-sync preview mock layer. Fields cover only
// what the grading components read. Everything is cast `as any` at use sites.
/* eslint-disable @typescript-eslint/no-explicit-any */

export const GRADER_ID = "grader-1111";
export const INSTRUCTOR_ID = "instr-2222";
export const STUDENT_ID = "student-3333";

export const profiles: Record<string, any> = {
  [GRADER_ID]: { id: GRADER_ID, name: "Jordan Lee", real_name: "Jordan Lee", short_name: "Jordan", flair: "TA", flair_color: "blue", avatar_url: null, sortable_name: "Lee, Jordan" },
  [INSTRUCTOR_ID]: { id: INSTRUCTOR_ID, name: "Prof. Bell", real_name: "Prof. Bell", short_name: "Prof. Bell", flair: "Instructor", flair_color: "purple", avatar_url: null, sortable_name: "Bell" },
  [STUDENT_ID]: { id: STUDENT_ID, name: "Priya Natarajan", real_name: "Priya Natarajan", short_name: "Priya", flair: null, flair_color: null, avatar_url: null, sortable_name: "Natarajan, Priya" }
};

export const codeFileContents = `public class BinarySearchTree {
    private Node root;

    public void insert(int key) {
        root = insertRec(root, key);
    }

    private Node insertRec(Node node, int key) {
        if (node == null) return new Node(key);
        if (key < node.key)      node.left  = insertRec(node.left, key);
        else if (key > node.key) node.right = insertRec(node.right, key);
        return node;
    }

    public boolean contains(int key) {
        Node cur = root;
        while (cur != null) {
            if (key == cur.key) return true;
            cur = key < cur.key ? cur.left : cur.right;
        }
        return false;
    }
}
`;

export const submissionFile: any = {
  id: 1,
  name: "src/BinarySearchTree.java",
  contents: codeFileContents,
  is_binary: false,
  class_id: 1,
  submission_id: 1,
  profile_id: STUDENT_ID
};

export const submission: any = {
  id: 1,
  class_id: 1,
  assignment_id: 1,
  profile_id: STUDENT_ID,
  assignment_group_id: null,
  grading_review_id: 1,
  ordinal: 3,
  released: null,
  created_at: "2026-03-15T18:22:00Z",
  submission_files: [submissionFile],
  submission_artifacts: [],
  assignments: { id: 1, title: "Problem Set 4 — Binary Search Trees", total_points: 100 }
};

export const assignment: any = {
  id: 1,
  class_id: 1,
  title: "Problem Set 4 — Binary Search Trees",
  grading_rubric_id: 1,
  self_review_rubric_id: null,
  total_points: 100,
  grader_pseudonymous_mode: false,
  isReady: true
};

export const submissionReview: any = {
  id: 1,
  submission_id: 1,
  rubric_id: 1,
  class_id: 1,
  name: "Grading Review",
  released: false,
  completed_at: null,
  total_score: 87,
  total_autograde_score: 40,
  tweak: 0,
  tweak_note: null,
  per_student_tweaks: null,
  per_student_tweak_notes: null,
  target_student_profile_id: null,
  grader: GRADER_ID
};

// ── Rubric tree (grading review) ───────────────────────────────────────────
export const rubric: any = {
  id: 1,
  assignment_id: 1,
  class_id: 1,
  name: "Grading Review",
  description: "Correctness and code quality for the BST assignment.",
  review_round: "grading-review"
};

export const rubricParts: any[] = [
  { id: 10, rubric_id: 1, class_id: 1, name: "Correctness", description: "Does the implementation behave correctly?", ordinal: 0, is_assign_to_student: false, is_individual_grading: false },
  { id: 11, rubric_id: 1, class_id: 1, name: "Code Quality", description: "Readability and structure.", ordinal: 1, is_assign_to_student: false, is_individual_grading: false }
];

export const rubricCriteria: any[] = [
  { id: 100, rubric_part_id: 10, rubric_id: 1, class_id: 1, name: "Core operations", description: "insert / contains / delete", ordinal: 0, total_points: 40, is_additive: true, is_deduction_only: false, min_checks_per_submission: 1, max_checks_per_submission: null },
  { id: 110, rubric_part_id: 11, rubric_id: 1, class_id: 1, name: "Style & documentation", description: "Naming, comments, decomposition.", ordinal: 0, total_points: 10, is_additive: false, is_deduction_only: true, min_checks_per_submission: 0, max_checks_per_submission: null }
];

export const rubricChecks: any[] = [
  { id: 1000, rubric_criteria_id: 100, rubric_id: 1, class_id: 1, name: "All insert tests pass", description: "24/24 insertion tests green.", points: 15, ordinal: 0, is_annotation: false, is_required: true, is_comment_required: false, student_visibility: "always", annotation_target: null, data: null, kpi_category: null },
  { id: 1001, rubric_criteria_id: 100, rubric_id: 1, class_id: 1, name: "contains() is correct", description: "Lookup returns correct results.", points: 25, ordinal: 1, is_annotation: false, is_required: true, is_comment_required: false, student_visibility: "always", annotation_target: null, data: null, kpi_category: null },
  { id: 1100, rubric_criteria_id: 110, rubric_id: 1, class_id: 1, name: "Missing Javadoc", description: "Annotate public methods lacking documentation.", points: -2, ordinal: 0, is_annotation: true, is_required: false, is_comment_required: true, student_visibility: "always", annotation_target: "file", data: null, kpi_category: null }
];

// Applied instances (a global check applied + a line annotation)
export const submissionComments: any[] = [
  { id: 5000, submission_id: 1, rubric_check_id: 1000, submission_review_id: 1, class_id: 1, author: GRADER_ID, comment: "Confirmed — all insertion tests pass.", points: 15, released: false, eventually_visible: true, created_at: "2026-03-16T14:00:00Z", regrade_request_id: null, deleted_at: null }
];

export const submissionFileComments: any[] = [
  { id: 6000, submission_file_id: 1, submission_id: 1, rubric_check_id: 1100, submission_review_id: 1, class_id: 1, line: 14, author: GRADER_ID, comment: "`contains` is missing a Javadoc comment.", points: -2, released: false, eventually_visible: true, created_at: "2026-03-16T14:05:00Z", regrade_request_id: null, deleted_at: null }
];

export const classProfiles = {
  private_profile_id: GRADER_ID,
  public_profile_id: GRADER_ID,
  isReadOnly: false,
  role: { role: "grader" } as any,
  courseRole: "grader"
};
