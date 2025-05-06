export interface Enrollment {
  id: number;
  user_id: number;
  course_id: number;
  type: string;
  created_at: Date;
  updated_at: Date;
  associated_user_id: null;
  start_at: null;
  end_at: null;
  course_section_id: number;
  root_account_id: number;
  limit_privileges_to_course_section: boolean;
  enrollment_state: string;
  role: string;
  role_id: number;
  last_activity_at: Date;
  last_attended_at: null;
  total_activity_time: number;
  grades: Grades;
  sis_account_id: string;
  sis_course_id: string;
  course_integration_id: null;
  sis_section_id: string;
  section_integration_id: null;
  sis_user_id: string;
  html_url: string;
  user: User;
}
export interface Grades {
  html_url: string;
  current_grade: null;
  current_score: number;
  final_grade: null;
  final_score: number;
  unposted_current_score: number;
  unposted_current_grade: null;
  unposted_final_score: number;
  unposted_final_grade: null;
}
export interface User {
  id: number;
  name: string;
  created_at: Date;
  sortable_name: string;
  short_name: string;
  sis_user_id: string;
  integration_id: null;
  login_id: string;
}
export interface UserProfile {
  id: number;
  name: string;
  short_name: string;
  sortable_name: string;
  avatar_url: string;
  title: null;
  bio: null;
  pronunciation: null;
  primary_email: string;
  login_id: string;
  sis_user_id: string;
  integration_id: null;
  time_zone: string;
  locale: null;
}
export interface Course {
  id: number;
  name: string;
  account_id: number;
  uuid: string;
  start_at: null;
  grading_standard_id: null;
  is_public: boolean;
  created_at: Date;
  course_code: string;
  default_view: string;
  root_account_id: number;
  enrollment_term_id: number;
  license: string;
  grade_passback_setting: null;
  end_at: Date;
  public_syllabus: boolean;
  public_syllabus_to_auth: boolean;
  storage_quota_mb: number;
  is_public_to_auth_users: boolean;
  homeroom_course: boolean;
  course_color: null;
  friendly_name: null;
  apply_assignment_group_weights: boolean;
  calendar: Calendar;
  time_zone: string;
  blueprint: boolean;
  template: boolean;
  sis_course_id: null;
  integration_id: null;
  enrollments: Enrollment[];
  hide_final_grades: boolean;
  workflow_state: string;
  restrict_enrollments_to_course_dates: boolean;
}

export interface Calendar {
  ics: string;
}
