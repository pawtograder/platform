/**
 * Types for the Pawtograder MCP Server Edge Function
 * These types mirror the database schema but exclude sensitive fields
 */

// Safe profile type - excludes is_private_profile and other sensitive fields
export interface SafeProfile {
  id: string;
  name: string | null;
  avatar_url: string | null;
  class_id: number;
}

// Assignment context returned to MCP clients
export interface AssignmentContext {
  id: number;
  title: string;
  slug: string | null;
  description: string | null;
  handout_url: string | null;
  due_date: string;
  release_date: string | null;
  total_points: number | null;
  has_autograder: boolean;
  class_id: number;
  template_repo: string | null;
}

// Help request context for MCP
export interface HelpRequestContext {
  id: number;
  request: string;
  status: string;
  created_at: string;
  updated_at: string;
  assignment?: AssignmentContext | null;
  submission?: SubmissionContext | null;
  latest_submission?: SubmissionContext | null;
  student_profile_id: string | null;
  student_name: string | null;
  help_queue_name: string;
  messages: HelpRequestMessage[];
}

export interface HelpRequestMessage {
  id: number;
  content: string;
  created_at: string;
  author_name: string | null;
  is_staff: boolean;
}

// Discussion thread context for MCP
export interface DiscussionThreadContext {
  id: number;
  subject: string;
  body: string;
  created_at: string;
  updated_at: string;
  is_question: boolean;
  children_count: number;
  author_profile_id: string | null;
  author_name: string | null;
  assignment?: AssignmentContext | null;
  latest_submission?: SubmissionContext | null;
  replies: DiscussionReplyContext[];
}

export interface DiscussionReplyContext {
  id: number;
  body: string;
  created_at: string;
  author_name: string | null;
  is_staff: boolean;
  is_answer: boolean;
}

// Submission file context
export interface SubmissionFileContext {
  id: number;
  name: string;
  contents: string;
}

// Submission context for MCP
export interface SubmissionContext {
  id: number;
  assignment_id: number;
  created_at: string;
  sha: string;
  repository: string;
  ordinal: number;
  is_active: boolean;
  student_name: string | null;
  grader_result?: GraderResultContext | null;
  files?: SubmissionFileContext[];
}

// Grader result context
export interface GraderResultContext {
  id: number;
  score: number;
  max_score: number;
  lint_passed: boolean;
  lint_output: string;
  lint_output_format: string;
  errors: unknown | null;
  execution_time: number | null;
  ret_code: number | null;
  tests: TestResultContext[];
  build_output?: BuildOutputContext | null;
}

// Test result context
export interface TestResultContext {
  id: number;
  name: string;
  part: string | null;
  score: number | null;
  max_score: number | null;
  output: string | null;
  output_format: string | null;
  is_released: boolean;
}

// Build output context
export interface BuildOutputContext {
  stdout: string | null;
  stderr: string | null;
  combined_output: string | null;
  output_format: string | null;
}

// User role information (for authorization)
export interface UserRole {
  class_id: number;
  role: "instructor" | "grader" | "student";
  private_profile_id: string;
}

// Handout file from GitHub
export interface HandoutFileContext {
  path: string;
  content: string;
}

// Grader/test file from GitHub
export interface GraderFileContext {
  path: string;
  content: string;
}
