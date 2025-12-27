export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  pgmq_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      archive: {
        Args: { message_id: number; queue_name: string }
        Returns: boolean
      }
      delete: {
        Args: { message_id: number; queue_name: string }
        Returns: boolean
      }
      pop: {
        Args: { queue_name: string }
        Returns: unknown[]
        SetofOptions: {
          from: "*"
          to: "message_record"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      read: {
        Args: { n: number; queue_name: string; sleep_seconds: number }
        Returns: unknown[]
        SetofOptions: {
          from: "*"
          to: "message_record"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      send: {
        Args: { message: Json; queue_name: string; sleep_seconds?: number }
        Returns: number[]
      }
      send_batch: {
        Args: { messages: Json[]; queue_name: string; sleep_seconds?: number }
        Returns: number[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      api_gateway_calls: {
        Row: {
          class_id: number | null
          created_at: string
          debug_id: string | null
          id: number
          latency_ms: number | null
          message_processed_at: string | null
          method: Database["public"]["Enums"]["github_async_method"]
          status_code: number
        }
        Insert: {
          class_id?: number | null
          created_at?: string
          debug_id?: string | null
          id?: number
          latency_ms?: number | null
          message_processed_at?: string | null
          method: Database["public"]["Enums"]["github_async_method"]
          status_code: number
        }
        Update: {
          class_id?: number | null
          created_at?: string
          debug_id?: string | null
          id?: number
          latency_ms?: number | null
          message_processed_at?: string | null
          method?: Database["public"]["Enums"]["github_async_method"]
          status_code?: number
        }
        Relationships: [
          {
            foreignKeyName: "api_gateway_calls_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      assignment_due_date_exceptions: {
        Row: {
          assignment_group_id: number | null
          assignment_id: number
          class_id: number | null
          created_at: string
          creator_id: string
          hours: number
          id: number
          minutes: number
          note: string | null
          student_id: string | null
          tokens_consumed: number
          updated_at: string
        }
        Insert: {
          assignment_group_id?: number | null
          assignment_id: number
          class_id?: number | null
          created_at?: string
          creator_id: string
          hours: number
          id?: number
          minutes?: number
          note?: string | null
          student_id?: string | null
          tokens_consumed?: number
          updated_at?: string
        }
        Update: {
          assignment_group_id?: number | null
          assignment_id?: number
          class_id?: number | null
          created_at?: string
          creator_id?: string
          hours?: number
          id?: number
          minutes?: number
          note?: string | null
          student_id?: string | null
          tokens_consumed?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignment_late_exception_assignment_group_id_fkey"
            columns: ["assignment_group_id"]
            isOneToOne: false
            referencedRelation: "assignment_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_late_exception_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_late_exception_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_late_exception_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_late_exception_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_late_exception_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "assignment_late_exception_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_late_exception_instructor_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_late_exception_instructor_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "assignment_late_exception_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_late_exception_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      assignment_group_invitations: {
        Row: {
          assignment_group_id: number
          class_id: number
          created_at: string
          id: number
          invitee: string
          inviter: string
        }
        Insert: {
          assignment_group_id: number
          class_id: number
          created_at?: string
          id?: number
          invitee?: string
          inviter?: string
        }
        Update: {
          assignment_group_id?: number
          class_id?: number
          created_at?: string
          id?: number
          invitee?: string
          inviter?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignment_group_invitation_assignment_group_id_fkey"
            columns: ["assignment_group_id"]
            isOneToOne: false
            referencedRelation: "assignment_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_group_invitation_invitee_fkey"
            columns: ["invitee"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_group_invitation_invitee_fkey"
            columns: ["invitee"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "assignment_group_invitation_inviter_fkey"
            columns: ["inviter"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_group_invitation_inviter_fkey"
            columns: ["inviter"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "assignment_group_invitations_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      assignment_group_join_request: {
        Row: {
          assignment_group_id: number
          assignment_id: number
          class_id: number
          created_at: string
          decided_at: string | null
          decision_maker: string | null
          id: number
          profile_id: string
          status: Database["public"]["Enums"]["assignment_group_join_status"]
        }
        Insert: {
          assignment_group_id: number
          assignment_id: number
          class_id: number
          created_at?: string
          decided_at?: string | null
          decision_maker?: string | null
          id?: number
          profile_id: string
          status?: Database["public"]["Enums"]["assignment_group_join_status"]
        }
        Update: {
          assignment_group_id?: number
          assignment_id?: number
          class_id?: number
          created_at?: string
          decided_at?: string | null
          decision_maker?: string | null
          id?: number
          profile_id?: string
          status?: Database["public"]["Enums"]["assignment_group_join_status"]
        }
        Relationships: [
          {
            foreignKeyName: "assignment_group_join_request_assignment_group_id_fkey"
            columns: ["assignment_group_id"]
            isOneToOne: false
            referencedRelation: "assignment_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_group_join_request_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_group_join_request_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_group_join_request_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_group_join_request_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_group_join_request_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "assignment_group_join_request_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_group_join_request_decision_maker_fkey"
            columns: ["decision_maker"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_group_join_request_decision_maker_fkey"
            columns: ["decision_maker"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "assignment_group_join_request_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_group_join_request_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "assignment_group_join_request_profile_id_fkey1"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["student_profile_id"]
          },
          {
            foreignKeyName: "assignment_group_join_request_profile_id_fkey1"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "assignment_group_join_request_profile_id_fkey1"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "user_roles"
            referencedColumns: ["private_profile_id"]
          },
        ]
      }
      assignment_groups: {
        Row: {
          assignment_id: number
          class_id: number
          created_at: string
          id: number
          name: string
        }
        Insert: {
          assignment_id: number
          class_id: number
          created_at?: string
          id?: number
          name: string
        }
        Update: {
          assignment_id?: number
          class_id?: number
          created_at?: string
          id?: number
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignment_groups_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_groups_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_groups_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_groups_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_groups_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "assignment_groups_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      assignment_groups_members: {
        Row: {
          added_by: string
          assignment_group_id: number
          assignment_id: number
          class_id: number
          created_at: string
          id: number
          profile_id: string
        }
        Insert: {
          added_by: string
          assignment_group_id: number
          assignment_id: number
          class_id: number
          created_at?: string
          id?: number
          profile_id?: string
        }
        Update: {
          added_by?: string
          assignment_group_id?: number
          assignment_id?: number
          class_id?: number
          created_at?: string
          id?: number
          profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignment_groups_members_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_groups_members_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "assignment_groups_members_assignment_group_id_fkey"
            columns: ["assignment_group_id"]
            isOneToOne: false
            referencedRelation: "assignment_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_groups_members_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_groups_members_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_groups_members_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_groups_members_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_groups_members_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "assignment_groups_members_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_groups_members_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_groups_members_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "assignment_groups_members_profile_id_fkey1"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["student_profile_id"]
          },
          {
            foreignKeyName: "assignment_groups_members_profile_id_fkey1"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "assignment_groups_members_profile_id_fkey1"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "user_roles"
            referencedColumns: ["private_profile_id"]
          },
        ]
      }
      assignment_handout_commits: {
        Row: {
          assignment_id: number
          author: string | null
          class_id: number | null
          created_at: string
          id: number
          message: string
          sha: string
        }
        Insert: {
          assignment_id: number
          author?: string | null
          class_id?: number | null
          created_at?: string
          id?: number
          message: string
          sha: string
        }
        Update: {
          assignment_id?: number
          author?: string | null
          class_id?: number | null
          created_at?: string
          id?: number
          message?: string
          sha?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignment_handout_commit_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_handout_commit_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_handout_commit_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_handout_commit_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_handout_commit_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "assignment_handout_commits_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      assignment_self_review_settings: {
        Row: {
          allow_early: boolean | null
          class_id: number
          deadline_offset: number | null
          enabled: boolean
          id: number
        }
        Insert: {
          allow_early?: boolean | null
          class_id: number
          deadline_offset?: number | null
          enabled?: boolean
          id?: number
        }
        Update: {
          allow_early?: boolean | null
          class_id?: number
          deadline_offset?: number | null
          enabled?: boolean
          id?: number
        }
        Relationships: [
          {
            foreignKeyName: "self_review_settings_class_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      assignments: {
        Row: {
          allow_not_graded_submissions: boolean
          allow_student_formed_groups: boolean | null
          archived_at: string | null
          autograder_points: number | null
          class_id: number
          created_at: string
          description: string | null
          due_date: string
          gradebook_column_id: number | null
          grader_pseudonymous_mode: boolean
          grading_rubric_id: number | null
          group_config: Database["public"]["Enums"]["assignment_group_mode"]
          group_formation_deadline: string | null
          has_autograder: boolean
          has_handgrader: boolean
          id: number
          latest_template_sha: string | null
          max_group_size: number | null
          max_late_tokens: number
          meta_grading_rubric_id: number | null
          min_group_size: number | null
          minutes_due_after_lab: number | null
          regrade_deadline: string | null
          release_date: string | null
          self_review_rubric_id: number | null
          self_review_setting_id: number
          slug: string | null
          student_repo_prefix: string | null
          template_repo: string | null
          title: string
          total_points: number | null
          updated_at: string
        }
        Insert: {
          allow_not_graded_submissions?: boolean
          allow_student_formed_groups?: boolean | null
          archived_at?: string | null
          autograder_points?: number | null
          class_id: number
          created_at?: string
          description?: string | null
          due_date: string
          gradebook_column_id?: number | null
          grader_pseudonymous_mode?: boolean
          grading_rubric_id?: number | null
          group_config: Database["public"]["Enums"]["assignment_group_mode"]
          group_formation_deadline?: string | null
          has_autograder?: boolean
          has_handgrader?: boolean
          id?: number
          latest_template_sha?: string | null
          max_group_size?: number | null
          max_late_tokens?: number
          meta_grading_rubric_id?: number | null
          min_group_size?: number | null
          minutes_due_after_lab?: number | null
          regrade_deadline?: string | null
          release_date?: string | null
          self_review_rubric_id?: number | null
          self_review_setting_id: number
          slug?: string | null
          student_repo_prefix?: string | null
          template_repo?: string | null
          title: string
          total_points?: number | null
          updated_at?: string
        }
        Update: {
          allow_not_graded_submissions?: boolean
          allow_student_formed_groups?: boolean | null
          archived_at?: string | null
          autograder_points?: number | null
          class_id?: number
          created_at?: string
          description?: string | null
          due_date?: string
          gradebook_column_id?: number | null
          grader_pseudonymous_mode?: boolean
          grading_rubric_id?: number | null
          group_config?: Database["public"]["Enums"]["assignment_group_mode"]
          group_formation_deadline?: string | null
          has_autograder?: boolean
          has_handgrader?: boolean
          id?: number
          latest_template_sha?: string | null
          max_group_size?: number | null
          max_late_tokens?: number
          meta_grading_rubric_id?: number | null
          min_group_size?: number | null
          minutes_due_after_lab?: number | null
          regrade_deadline?: string | null
          release_date?: string | null
          self_review_rubric_id?: number | null
          self_review_setting_id?: number
          slug?: string | null
          student_repo_prefix?: string | null
          template_repo?: string | null
          title?: string
          total_points?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignments_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_meta_grading_rubric_id_fkey"
            columns: ["meta_grading_rubric_id"]
            isOneToOne: false
            referencedRelation: "rubrics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_rubric_id_fkey"
            columns: ["grading_rubric_id"]
            isOneToOne: false
            referencedRelation: "rubrics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_self_review_rubric_id_fkey"
            columns: ["self_review_rubric_id"]
            isOneToOne: false
            referencedRelation: "rubrics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_self_review_setting_fkey"
            columns: ["self_review_setting_id"]
            isOneToOne: false
            referencedRelation: "assignment_self_review_settings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_self_review_setting_fkey"
            columns: ["self_review_setting_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["assignment_self_review_setting_id"]
          },
        ]
      }
      async_worker_dlq_messages: {
        Row: {
          class_id: number | null
          created_at: string
          debug_id: string | null
          envelope: Json
          error_message: string | null
          error_type: string | null
          id: number
          last_error_context: Json | null
          log_id: number | null
          method: Database["public"]["Enums"]["github_async_method"]
          original_msg_id: number | null
          retry_count: number
        }
        Insert: {
          class_id?: number | null
          created_at?: string
          debug_id?: string | null
          envelope: Json
          error_message?: string | null
          error_type?: string | null
          id?: number
          last_error_context?: Json | null
          log_id?: number | null
          method: Database["public"]["Enums"]["github_async_method"]
          original_msg_id?: number | null
          retry_count: number
        }
        Update: {
          class_id?: number | null
          created_at?: string
          debug_id?: string | null
          envelope?: Json
          error_message?: string | null
          error_type?: string | null
          id?: number
          last_error_context?: Json | null
          log_id?: number | null
          method?: Database["public"]["Enums"]["github_async_method"]
          original_msg_id?: number | null
          retry_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "async_worker_dlq_messages_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      audit: {
        Row: {
          class_id: number
          created_at: string
          id: number
          ip_addr: string | null
          new: Json | null
          old: Json | null
          table: string
          user_id: string | null
        }
        Insert: {
          class_id: number
          created_at?: string
          id?: number
          ip_addr?: string | null
          new?: Json | null
          old?: Json | null
          table: string
          user_id?: string | null
        }
        Update: {
          class_id?: number
          created_at?: string
          id?: number
          ip_addr?: string | null
          new?: Json | null
          old?: Json | null
          table?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      autograder: {
        Row: {
          class_id: number | null
          config: Json | null
          created_at: string
          grader_commit_sha: string | null
          grader_repo: string | null
          id: number
          latest_autograder_sha: string | null
          max_submissions_count: number | null
          max_submissions_period_secs: number | null
          workflow_sha: string | null
        }
        Insert: {
          class_id?: number | null
          config?: Json | null
          created_at?: string
          grader_commit_sha?: string | null
          grader_repo?: string | null
          id: number
          latest_autograder_sha?: string | null
          max_submissions_count?: number | null
          max_submissions_period_secs?: number | null
          workflow_sha?: string | null
        }
        Update: {
          class_id?: number | null
          config?: Json | null
          created_at?: string
          grader_commit_sha?: string | null
          grader_repo?: string | null
          id?: number
          latest_autograder_sha?: string | null
          max_submissions_count?: number | null
          max_submissions_period_secs?: number | null
          workflow_sha?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "autograder_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_configs_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_configs_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_configs_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_configs_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_configs_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
        ]
      }
      autograder_commits: {
        Row: {
          author: string | null
          autograder_id: number
          class_id: number
          created_at: string
          id: number
          message: string
          ref: string
          sha: string
        }
        Insert: {
          author?: string | null
          autograder_id: number
          class_id: number
          created_at?: string
          id?: number
          message: string
          ref: string
          sha: string
        }
        Update: {
          author?: string | null
          autograder_id?: number
          class_id?: number
          created_at?: string
          id?: number
          message?: string
          ref?: string
          sha?: string
        }
        Relationships: [
          {
            foreignKeyName: "autograder_commits_assignment_id_fkey"
            columns: ["autograder_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "autograder_commits_assignment_id_fkey"
            columns: ["autograder_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "autograder_commits_assignment_id_fkey"
            columns: ["autograder_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "autograder_commits_assignment_id_fkey"
            columns: ["autograder_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "autograder_commits_assignment_id_fkey"
            columns: ["autograder_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "autograder_commits_autograder_id_fkey"
            columns: ["autograder_id"]
            isOneToOne: false
            referencedRelation: "autograder"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "autograder_commits_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "autograder_commits_class_id_fkey1"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      autograder_regression_test: {
        Row: {
          autograder_id: number
          created_at: string
          id: number
          repository: string
        }
        Insert: {
          autograder_id: number
          created_at?: string
          id?: number
          repository: string
        }
        Update: {
          autograder_id?: number
          created_at?: string
          id?: number
          repository?: string
        }
        Relationships: [
          {
            foreignKeyName: "autograder_regression_test_autograder_id_fkey"
            columns: ["autograder_id"]
            isOneToOne: false
            referencedRelation: "autograder"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_events: {
        Row: {
          calendar_type: string
          change_announced_at: string | null
          class_id: number
          created_at: string
          description: string | null
          end_announced_at: string | null
          end_time: string
          id: number
          location: string | null
          organizer_name: string | null
          queue_name: string | null
          raw_ics_data: Json | null
          start_announced_at: string | null
          start_time: string
          title: string
          uid: string
          updated_at: string
        }
        Insert: {
          calendar_type: string
          change_announced_at?: string | null
          class_id: number
          created_at?: string
          description?: string | null
          end_announced_at?: string | null
          end_time: string
          id?: number
          location?: string | null
          organizer_name?: string | null
          queue_name?: string | null
          raw_ics_data?: Json | null
          start_announced_at?: string | null
          start_time: string
          title: string
          uid: string
          updated_at?: string
        }
        Update: {
          calendar_type?: string
          change_announced_at?: string | null
          class_id?: number
          created_at?: string
          description?: string | null
          end_announced_at?: string | null
          end_time?: string
          id?: number
          location?: string | null
          organizer_name?: string | null
          queue_name?: string | null
          raw_ics_data?: Json | null
          start_announced_at?: string | null
          start_time?: string
          title?: string
          uid?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_events_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_sync_state: {
        Row: {
          calendar_type: string
          class_id: number
          created_at: string
          id: number
          last_etag: string | null
          last_hash: string | null
          last_sync_at: string | null
          sync_error: string | null
        }
        Insert: {
          calendar_type: string
          class_id: number
          created_at?: string
          id?: number
          last_etag?: string | null
          last_hash?: string | null
          last_sync_at?: string | null
          sync_error?: string | null
        }
        Update: {
          calendar_type?: string
          class_id?: number
          created_at?: string
          id?: number
          last_etag?: string | null
          last_hash?: string | null
          last_sync_at?: string | null
          sync_error?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "calendar_sync_state_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      class_metrics_totals: {
        Row: {
          active_graders_total: number | null
          active_instructors_total: number | null
          active_students_total: number | null
          assignments_total: number | null
          class_id: number
          created_at: string
          discussion_threads_total: number | null
          gradebook_columns_total: number | null
          help_request_messages_total: number | null
          help_requests_open: number | null
          help_requests_total: number | null
          hint_feedback_total: number | null
          hint_feedback_useful_total: number | null
          hint_feedback_with_comments: number | null
          late_token_usage_total: number | null
          llm_inference_total: number | null
          llm_input_tokens_total: number | null
          llm_output_tokens_total: number | null
          notifications_unread: number | null
          regrade_requests_total: number | null
          submission_comments_total: number | null
          submission_reviews_total: number | null
          submissions_total: number | null
          updated_at: string
          video_meeting_participants_total: number | null
          video_meeting_sessions_total: number | null
          workflow_errors_total: number | null
          workflow_runs_completed: number | null
          workflow_runs_failed: number | null
        }
        Insert: {
          active_graders_total?: number | null
          active_instructors_total?: number | null
          active_students_total?: number | null
          assignments_total?: number | null
          class_id: number
          created_at?: string
          discussion_threads_total?: number | null
          gradebook_columns_total?: number | null
          help_request_messages_total?: number | null
          help_requests_open?: number | null
          help_requests_total?: number | null
          hint_feedback_total?: number | null
          hint_feedback_useful_total?: number | null
          hint_feedback_with_comments?: number | null
          late_token_usage_total?: number | null
          llm_inference_total?: number | null
          llm_input_tokens_total?: number | null
          llm_output_tokens_total?: number | null
          notifications_unread?: number | null
          regrade_requests_total?: number | null
          submission_comments_total?: number | null
          submission_reviews_total?: number | null
          submissions_total?: number | null
          updated_at?: string
          video_meeting_participants_total?: number | null
          video_meeting_sessions_total?: number | null
          workflow_errors_total?: number | null
          workflow_runs_completed?: number | null
          workflow_runs_failed?: number | null
        }
        Update: {
          active_graders_total?: number | null
          active_instructors_total?: number | null
          active_students_total?: number | null
          assignments_total?: number | null
          class_id?: number
          created_at?: string
          discussion_threads_total?: number | null
          gradebook_columns_total?: number | null
          help_request_messages_total?: number | null
          help_requests_open?: number | null
          help_requests_total?: number | null
          hint_feedback_total?: number | null
          hint_feedback_useful_total?: number | null
          hint_feedback_with_comments?: number | null
          late_token_usage_total?: number | null
          llm_inference_total?: number | null
          llm_input_tokens_total?: number | null
          llm_output_tokens_total?: number | null
          notifications_unread?: number | null
          regrade_requests_total?: number | null
          submission_comments_total?: number | null
          submission_reviews_total?: number | null
          submissions_total?: number | null
          updated_at?: string
          video_meeting_participants_total?: number | null
          video_meeting_sessions_total?: number | null
          workflow_errors_total?: number | null
          workflow_runs_completed?: number | null
          workflow_runs_failed?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "class_metrics_totals_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: true
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      class_sections: {
        Row: {
          campus: string | null
          canvas_course_id: number | null
          canvas_course_section_id: number | null
          class_id: number
          created_at: string
          id: number
          meeting_location: string | null
          meeting_times: string | null
          name: string
          sis_crn: number | null
        }
        Insert: {
          campus?: string | null
          canvas_course_id?: number | null
          canvas_course_section_id?: number | null
          class_id: number
          created_at?: string
          id?: number
          meeting_location?: string | null
          meeting_times?: string | null
          name: string
          sis_crn?: number | null
        }
        Update: {
          campus?: string | null
          canvas_course_id?: number | null
          canvas_course_section_id?: number | null
          class_id?: number
          created_at?: string
          id?: number
          meeting_location?: string | null
          meeting_times?: string | null
          name?: string
          sis_crn?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "class_sections_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      class_staff_settings: {
        Row: {
          class_id: number
          created_at: string
          id: number
          setting_key: string
          setting_value: string | null
          updated_at: string
        }
        Insert: {
          class_id: number
          created_at?: string
          id?: number
          setting_key: string
          setting_value?: string | null
          updated_at?: string
        }
        Update: {
          class_id?: number
          created_at?: string
          id?: number
          setting_key?: string
          setting_value?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "class_staff_settings_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      classes: {
        Row: {
          archived: boolean | null
          course_title: string | null
          created_at: string
          description: string | null
          discord_channel_group_id: string | null
          discord_server_id: string | null
          end_date: string | null
          events_ics_url: string | null
          features: Json | null
          github_org: string | null
          gradebook_id: number | null
          id: number
          is_demo: boolean
          late_tokens_per_student: number
          name: string | null
          office_hours_ics_url: string | null
          slug: string | null
          start_date: string | null
          term: number | null
          time_zone: string
        }
        Insert: {
          archived?: boolean | null
          course_title?: string | null
          created_at?: string
          description?: string | null
          discord_channel_group_id?: string | null
          discord_server_id?: string | null
          end_date?: string | null
          events_ics_url?: string | null
          features?: Json | null
          github_org?: string | null
          gradebook_id?: number | null
          id?: number
          is_demo?: boolean
          late_tokens_per_student?: number
          name?: string | null
          office_hours_ics_url?: string | null
          slug?: string | null
          start_date?: string | null
          term?: number | null
          time_zone?: string
        }
        Update: {
          archived?: boolean | null
          course_title?: string | null
          created_at?: string
          description?: string | null
          discord_channel_group_id?: string | null
          discord_server_id?: string | null
          end_date?: string | null
          events_ics_url?: string | null
          features?: Json | null
          github_org?: string | null
          gradebook_id?: number | null
          id?: number
          is_demo?: boolean
          late_tokens_per_student?: number
          name?: string | null
          office_hours_ics_url?: string | null
          slug?: string | null
          start_date?: string | null
          term?: number | null
          time_zone?: string
        }
        Relationships: [
          {
            foreignKeyName: "classes_gradebook_id_fkey"
            columns: ["gradebook_id"]
            isOneToOne: false
            referencedRelation: "gradebooks"
            referencedColumns: ["id"]
          },
        ]
      }
      discord_async_worker_dlq_messages: {
        Row: {
          class_id: number | null
          created_at: string
          debug_id: string | null
          envelope: Json
          error_message: string | null
          error_type: string | null
          id: number
          last_error_context: Json | null
          log_id: number | null
          method: string
          original_msg_id: number | null
          retry_count: number
        }
        Insert: {
          class_id?: number | null
          created_at?: string
          debug_id?: string | null
          envelope: Json
          error_message?: string | null
          error_type?: string | null
          id?: number
          last_error_context?: Json | null
          log_id?: number | null
          method: string
          original_msg_id?: number | null
          retry_count: number
        }
        Update: {
          class_id?: number | null
          created_at?: string
          debug_id?: string | null
          envelope?: Json
          error_message?: string | null
          error_type?: string | null
          id?: number
          last_error_context?: Json | null
          log_id?: number | null
          method?: string
          original_msg_id?: number | null
          retry_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "discord_async_worker_dlq_messages_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      discord_channels: {
        Row: {
          channel_type: Database["public"]["Enums"]["discord_channel_type"]
          class_id: number
          created_at: string
          discord_channel_id: string
          id: number
          resource_id: number | null
        }
        Insert: {
          channel_type: Database["public"]["Enums"]["discord_channel_type"]
          class_id: number
          created_at?: string
          discord_channel_id: string
          id?: number
          resource_id?: number | null
        }
        Update: {
          channel_type?: Database["public"]["Enums"]["discord_channel_type"]
          class_id?: number
          created_at?: string
          discord_channel_id?: string
          id?: number
          resource_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "discord_channels_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      discord_invites: {
        Row: {
          class_id: number
          created_at: string
          expires_at: string
          guild_id: string
          id: number
          invite_code: string
          invite_url: string
          used: boolean
          user_id: string
        }
        Insert: {
          class_id: number
          created_at?: string
          expires_at: string
          guild_id: string
          id?: number
          invite_code: string
          invite_url: string
          used?: boolean
          user_id: string
        }
        Update: {
          class_id?: number
          created_at?: string
          expires_at?: string
          guild_id?: string
          id?: number
          invite_code?: string
          invite_url?: string
          used?: boolean
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "discord_invites_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discord_invites_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      discord_messages: {
        Row: {
          class_id: number
          created_at: string
          discord_channel_id: string
          discord_message_id: string
          id: number
          resource_id: number
          resource_type: Database["public"]["Enums"]["discord_resource_type"]
        }
        Insert: {
          class_id: number
          created_at?: string
          discord_channel_id: string
          discord_message_id: string
          id?: number
          resource_id: number
          resource_type: Database["public"]["Enums"]["discord_resource_type"]
        }
        Update: {
          class_id?: number
          created_at?: string
          discord_channel_id?: string
          discord_message_id?: string
          id?: number
          resource_id?: number
          resource_type?: Database["public"]["Enums"]["discord_resource_type"]
        }
        Relationships: [
          {
            foreignKeyName: "discord_messages_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      discord_roles: {
        Row: {
          class_id: number
          created_at: string
          discord_role_id: string
          id: number
          role_type: string
        }
        Insert: {
          class_id: number
          created_at?: string
          discord_role_id: string
          id?: number
          role_type: string
        }
        Update: {
          class_id?: number
          created_at?: string
          discord_role_id?: string
          id?: number
          role_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "discord_roles_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      discussion_digest_items: {
        Row: {
          action: string | null
          author_name: string
          class_id: number
          created_at: string
          id: number
          msg_id: number | null
          notification_reason: string | null
          teaser: string | null
          thread_id: number
          thread_name: string
          thread_url: string | null
          topic_id: number | null
          user_id: string
        }
        Insert: {
          action?: string | null
          author_name: string
          class_id: number
          created_at?: string
          id?: number
          msg_id?: number | null
          notification_reason?: string | null
          teaser?: string | null
          thread_id: number
          thread_name: string
          thread_url?: string | null
          topic_id?: number | null
          user_id: string
        }
        Update: {
          action?: string | null
          author_name?: string
          class_id?: number
          created_at?: string
          id?: number
          msg_id?: number | null
          notification_reason?: string | null
          teaser?: string | null
          thread_id?: number
          thread_name?: string
          thread_url?: string | null
          topic_id?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "discussion_digest_items_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_digest_items_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      discussion_digest_send_times: {
        Row: {
          class_id: number
          last_sent_at: string
          user_id: string
        }
        Insert: {
          class_id: number
          last_sent_at?: string
          user_id: string
        }
        Update: {
          class_id?: number
          last_sent_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "discussion_digest_send_times_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_digest_send_times_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      discussion_thread_likes: {
        Row: {
          created_at: string
          creator: string
          discussion_thread: number
          emoji: string
          id: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          creator: string
          discussion_thread: number
          emoji: string
          id?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          creator?: string
          discussion_thread?: number
          emoji?: string
          id?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "discussion_thread_likes_discussion_thread_fkey"
            columns: ["discussion_thread"]
            isOneToOne: false
            referencedRelation: "discussion_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_thread_likes_user_fkey"
            columns: ["creator"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_thread_likes_user_fkey"
            columns: ["creator"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      discussion_thread_ordinal_counters: {
        Row: {
          class_id: number
          next_ordinal: number
          updated_at: string
        }
        Insert: {
          class_id: number
          next_ordinal?: number
          updated_at?: string
        }
        Update: {
          class_id?: number
          next_ordinal?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "discussion_thread_ordinal_counters_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: true
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      discussion_thread_read_status: {
        Row: {
          created_at: string
          discussion_thread_id: number
          discussion_thread_root_id: number
          id: number
          read_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          discussion_thread_id: number
          discussion_thread_root_id: number
          id?: number
          read_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          discussion_thread_id?: number
          discussion_thread_root_id?: number
          id?: number
          read_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "discussion_thread_read_status_discussion_thread_id_fkey"
            columns: ["discussion_thread_id"]
            isOneToOne: false
            referencedRelation: "discussion_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_thread_read_status_discussion_thread_root_id_fkey"
            columns: ["discussion_thread_root_id"]
            isOneToOne: false
            referencedRelation: "discussion_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_thread_read_status_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      discussion_thread_watcher_cache: {
        Row: {
          discussion_thread_root_id: number
          exists: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          discussion_thread_root_id: number
          exists?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          discussion_thread_root_id?: number
          exists?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "discussion_thread_watcher_cache_root_id_fkey"
            columns: ["discussion_thread_root_id"]
            isOneToOne: false
            referencedRelation: "discussion_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      discussion_thread_watchers: {
        Row: {
          class_id: number
          created_at: string
          discussion_thread_root_id: number
          enabled: boolean
          id: number
          updated_at: string
          user_id: string
        }
        Insert: {
          class_id: number
          created_at?: string
          discussion_thread_root_id: number
          enabled?: boolean
          id?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          class_id?: number
          created_at?: string
          discussion_thread_root_id?: number
          enabled?: boolean
          id?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "discussion_thread_watchers_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_thread_watchers_discussion_thread_root_id_fkey"
            columns: ["discussion_thread_root_id"]
            isOneToOne: false
            referencedRelation: "discussion_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_thread_watchers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      discussion_threads: {
        Row: {
          answer: number | null
          author: string
          body: string
          children_count: number
          class_id: number
          created_at: string
          draft: boolean
          edited_at: string | null
          id: number
          instructors_only: boolean
          is_question: boolean
          likes_count: number
          ordinal: number | null
          parent: number | null
          pinned: boolean
          root: number | null
          root_class_id: number | null
          subject: string
          topic_id: number
          updated_at: string
        }
        Insert: {
          answer?: number | null
          author: string
          body: string
          children_count?: number
          class_id: number
          created_at?: string
          draft?: boolean
          edited_at?: string | null
          id?: number
          instructors_only?: boolean
          is_question?: boolean
          likes_count?: number
          ordinal?: number | null
          parent?: number | null
          pinned?: boolean
          root?: number | null
          root_class_id?: number | null
          subject: string
          topic_id: number
          updated_at?: string
        }
        Update: {
          answer?: number | null
          author?: string
          body?: string
          children_count?: number
          class_id?: number
          created_at?: string
          draft?: boolean
          edited_at?: string | null
          id?: number
          instructors_only?: boolean
          is_question?: boolean
          likes_count?: number
          ordinal?: number | null
          parent?: number | null
          pinned?: boolean
          root?: number | null
          root_class_id?: number | null
          subject?: string
          topic_id?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "dicussion_threads_author_fkey"
            columns: ["author"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dicussion_threads_author_fkey"
            columns: ["author"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "dicussion_threads_class_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dicussion_threads_parent_fkey"
            columns: ["parent"]
            isOneToOne: false
            referencedRelation: "discussion_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_threads_answer_fkey"
            columns: ["answer"]
            isOneToOne: false
            referencedRelation: "discussion_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_threads_root_fkey"
            columns: ["root"]
            isOneToOne: false
            referencedRelation: "discussion_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_threads_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "discussion_topics"
            referencedColumns: ["id"]
          },
        ]
      }
      discussion_topic_followers: {
        Row: {
          class_id: number
          created_at: string
          following: boolean
          id: number
          topic_id: number
          updated_at: string
          user_id: string
        }
        Insert: {
          class_id: number
          created_at?: string
          following?: boolean
          id?: number
          topic_id: number
          updated_at?: string
          user_id: string
        }
        Update: {
          class_id?: number
          created_at?: string
          following?: boolean
          id?: number
          topic_id?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "discussion_topic_followers_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_topic_followers_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "discussion_topics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_topic_followers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      discussion_topics: {
        Row: {
          assignment_id: number | null
          class_id: number
          color: string
          created_at: string
          default_follow: boolean
          description: string
          icon: string | null
          id: number
          ordinal: number
          topic: string
          updated_at: string
        }
        Insert: {
          assignment_id?: number | null
          class_id: number
          color: string
          created_at?: string
          default_follow?: boolean
          description: string
          icon?: string | null
          id?: number
          ordinal?: number
          topic: string
          updated_at?: string
        }
        Update: {
          assignment_id?: number | null
          class_id?: number
          color?: string
          created_at?: string
          default_follow?: boolean
          description?: string
          icon?: string | null
          id?: number
          ordinal?: number
          topic?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "discussion_topics_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_topics_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_topics_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_topics_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_topics_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "discussion_topics_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      email_batches: {
        Row: {
          body: string
          cc_emails: Json
          class_id: number
          created_at: string
          id: number
          reply_to: string | null
          subject: string
        }
        Insert: {
          body: string
          cc_emails: Json
          class_id: number
          created_at?: string
          id?: number
          reply_to?: string | null
          subject: string
        }
        Update: {
          body?: string
          cc_emails?: Json
          class_id?: number
          created_at?: string
          id?: number
          reply_to?: string | null
          subject?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_batches_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      emails: {
        Row: {
          batch_id: number
          body: string
          cc_emails: Json
          class_id: number
          created_at: string
          id: number
          reply_to: string | null
          subject: string
          user_id: string
        }
        Insert: {
          batch_id: number
          body: string
          cc_emails: Json
          class_id: number
          created_at?: string
          id?: number
          reply_to?: string | null
          subject: string
          user_id: string
        }
        Update: {
          batch_id?: number
          body?: string
          cc_emails?: Json
          class_id?: number
          created_at?: string
          id?: number
          reply_to?: string | null
          subject?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emails_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "email_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emails_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emails_users_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      flashcard_decks: {
        Row: {
          class_id: number
          created_at: string
          creator_id: string
          deleted_at: string | null
          description: string | null
          id: number
          name: string
          updated_at: string | null
        }
        Insert: {
          class_id: number
          created_at?: string
          creator_id: string
          deleted_at?: string | null
          description?: string | null
          id?: number
          name: string
          updated_at?: string | null
        }
        Update: {
          class_id?: number
          created_at?: string
          creator_id?: string
          deleted_at?: string | null
          description?: string | null
          id?: number
          name?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "flashcard_decks_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flashcard_decks_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      flashcard_interaction_logs: {
        Row: {
          action: Database["public"]["Enums"]["flashcard_actions"]
          card_id: number | null
          class_id: number
          created_at: string
          deck_id: number
          duration_on_card_ms: number
          id: number
          student_id: string
        }
        Insert: {
          action: Database["public"]["Enums"]["flashcard_actions"]
          card_id?: number | null
          class_id: number
          created_at?: string
          deck_id: number
          duration_on_card_ms: number
          id?: number
          student_id: string
        }
        Update: {
          action?: Database["public"]["Enums"]["flashcard_actions"]
          card_id?: number | null
          class_id?: number
          created_at?: string
          deck_id?: number
          duration_on_card_ms?: number
          id?: number
          student_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "flashcard_interaction_logs_card_id_fkey"
            columns: ["card_id"]
            isOneToOne: false
            referencedRelation: "flashcards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flashcard_interaction_logs_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flashcard_interaction_logs_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: false
            referencedRelation: "flashcard_deck_analytics"
            referencedColumns: ["deck_id"]
          },
          {
            foreignKeyName: "flashcard_interaction_logs_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: false
            referencedRelation: "flashcard_decks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flashcard_interaction_logs_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      flashcards: {
        Row: {
          answer: string
          class_id: number
          created_at: string
          deck_id: number
          deleted_at: string | null
          id: number
          order: number | null
          prompt: string
          title: string
          updated_at: string | null
        }
        Insert: {
          answer: string
          class_id: number
          created_at?: string
          deck_id: number
          deleted_at?: string | null
          id?: number
          order?: number | null
          prompt: string
          title: string
          updated_at?: string | null
        }
        Update: {
          answer?: string
          class_id?: number
          created_at?: string
          deck_id?: number
          deleted_at?: string | null
          id?: number
          order?: number | null
          prompt?: string
          title?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "flashcards_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flashcards_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: false
            referencedRelation: "flashcard_deck_analytics"
            referencedColumns: ["deck_id"]
          },
          {
            foreignKeyName: "flashcards_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: false
            referencedRelation: "flashcard_decks"
            referencedColumns: ["id"]
          },
        ]
      }
      github_async_errors: {
        Row: {
          created_at: string
          error_data: Json
          id: number
          method: string
          org: string
        }
        Insert: {
          created_at?: string
          error_data: Json
          id?: number
          method: string
          org: string
        }
        Update: {
          created_at?: string
          error_data?: Json
          id?: number
          method?: string
          org?: string
        }
        Relationships: []
      }
      github_circuit_breaker_events: {
        Row: {
          id: number
          key: string
          opened_at: string
          reason: string | null
          scope: string
        }
        Insert: {
          id?: number
          key: string
          opened_at?: string
          reason?: string | null
          scope: string
        }
        Update: {
          id?: number
          key?: string
          opened_at?: string
          reason?: string | null
          scope?: string
        }
        Relationships: []
      }
      github_circuit_breakers: {
        Row: {
          key: string
          last_reason: string | null
          open_until: string | null
          scope: string
          state: string
          trip_count: number
          updated_at: string
        }
        Insert: {
          key: string
          last_reason?: string | null
          open_until?: string | null
          scope: string
          state?: string
          trip_count?: number
          updated_at?: string
        }
        Update: {
          key?: string
          last_reason?: string | null
          open_until?: string | null
          scope?: string
          state?: string
          trip_count?: number
          updated_at?: string
        }
        Relationships: []
      }
      gradebook_column_students: {
        Row: {
          class_id: number
          created_at: string
          gradebook_column_id: number
          gradebook_id: number
          id: number
          incomplete_values: Json | null
          is_droppable: boolean
          is_excused: boolean
          is_missing: boolean
          is_private: boolean
          is_recalculating: boolean
          released: boolean
          score: number | null
          score_override: number | null
          score_override_note: string | null
          student_id: string
          updated_at: string
        }
        Insert: {
          class_id: number
          created_at?: string
          gradebook_column_id: number
          gradebook_id: number
          id?: number
          incomplete_values?: Json | null
          is_droppable?: boolean
          is_excused?: boolean
          is_missing?: boolean
          is_private: boolean
          is_recalculating?: boolean
          released?: boolean
          score?: number | null
          score_override?: number | null
          score_override_note?: string | null
          student_id?: string
          updated_at?: string
        }
        Update: {
          class_id?: number
          created_at?: string
          gradebook_column_id?: number
          gradebook_id?: number
          id?: number
          incomplete_values?: Json | null
          is_droppable?: boolean
          is_excused?: boolean
          is_missing?: boolean
          is_private?: boolean
          is_recalculating?: boolean
          released?: boolean
          score?: number | null
          score_override?: number | null
          score_override_note?: string | null
          student_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "gradebook_column_students_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gradebook_column_students_gradebook_column_id_fkey"
            columns: ["gradebook_column_id"]
            isOneToOne: false
            referencedRelation: "gradebook_columns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gradebook_column_students_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gradebook_column_students_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "gradebook_column_students_student_id_fkey1"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["student_profile_id"]
          },
          {
            foreignKeyName: "gradebook_column_students_student_id_fkey1"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "gradebook_column_students_student_id_fkey1"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "user_roles"
            referencedColumns: ["private_profile_id"]
          },
        ]
      }
      gradebook_columns: {
        Row: {
          class_id: number
          created_at: string
          dependencies: Json | null
          description: string | null
          external_data: Json | null
          gradebook_id: number
          id: number
          max_score: number | null
          name: string
          released: boolean
          render_expression: string | null
          score_expression: string | null
          show_calculated_ranges: boolean
          show_max_score: boolean
          slug: string
          sort_order: number | null
          updated_at: string
        }
        Insert: {
          class_id: number
          created_at?: string
          dependencies?: Json | null
          description?: string | null
          external_data?: Json | null
          gradebook_id: number
          id?: number
          max_score?: number | null
          name: string
          released?: boolean
          render_expression?: string | null
          score_expression?: string | null
          show_calculated_ranges?: boolean
          show_max_score?: boolean
          slug: string
          sort_order?: number | null
          updated_at?: string
        }
        Update: {
          class_id?: number
          created_at?: string
          dependencies?: Json | null
          description?: string | null
          external_data?: Json | null
          gradebook_id?: number
          id?: number
          max_score?: number | null
          name?: string
          released?: boolean
          render_expression?: string | null
          score_expression?: string | null
          show_calculated_ranges?: boolean
          show_max_score?: boolean
          slug?: string
          sort_order?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "gradebook_columns_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gradebook_columns_gradebook_id_fkey"
            columns: ["gradebook_id"]
            isOneToOne: false
            referencedRelation: "gradebooks"
            referencedColumns: ["id"]
          },
        ]
      }
      gradebook_row_recalc_state: {
        Row: {
          class_id: number
          dirty: boolean
          gradebook_id: number
          is_private: boolean
          is_recalculating: boolean
          student_id: string
          updated_at: string
          version: number
        }
        Insert: {
          class_id: number
          dirty?: boolean
          gradebook_id: number
          is_private: boolean
          is_recalculating?: boolean
          student_id: string
          updated_at?: string
          version?: number
        }
        Update: {
          class_id?: number
          dirty?: boolean
          gradebook_id?: number
          is_private?: boolean
          is_recalculating?: boolean
          student_id?: string
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      gradebooks: {
        Row: {
          class_id: number
          created_at: string
          description: string | null
          expression_prefix: string | null
          final_grade_column: number | null
          id: number
          name: string
        }
        Insert: {
          class_id: number
          created_at?: string
          description?: string | null
          expression_prefix?: string | null
          final_grade_column?: number | null
          id?: number
          name: string
        }
        Update: {
          class_id?: number
          created_at?: string
          description?: string | null
          expression_prefix?: string | null
          final_grade_column?: number | null
          id?: number
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "gradebooks_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gradebooks_final_grade_column_fkey"
            columns: ["final_grade_column"]
            isOneToOne: false
            referencedRelation: "gradebook_columns"
            referencedColumns: ["id"]
          },
        ]
      }
      grader_keys: {
        Row: {
          class_id: number
          created_at: string
          id: number
          key: string
          note: string | null
        }
        Insert: {
          class_id: number
          created_at?: string
          id?: number
          key?: string
          note?: string | null
        }
        Update: {
          class_id?: number
          created_at?: string
          id?: number
          key?: string
          note?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "grader_keys_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      grader_links_cache: {
        Row: {
          created_at: string
          expires_at: string
          id: number
          repo: string
          sha: string
          signed_url: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          id?: number
          repo: string
          sha: string
          signed_url: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: number
          repo?: string
          sha?: string
          signed_url?: string
        }
        Relationships: []
      }
      grader_result_output: {
        Row: {
          assignment_group_id: number | null
          class_id: number
          created_at: string
          format: string
          grader_result_id: number
          id: number
          output: string
          student_id: string | null
          visibility: Database["public"]["Enums"]["feedback_visibility"]
        }
        Insert: {
          assignment_group_id?: number | null
          class_id: number
          created_at?: string
          format: string
          grader_result_id: number
          id?: number
          output: string
          student_id?: string | null
          visibility: Database["public"]["Enums"]["feedback_visibility"]
        }
        Update: {
          assignment_group_id?: number | null
          class_id?: number
          created_at?: string
          format?: string
          grader_result_id?: number
          id?: number
          output?: string
          student_id?: string | null
          visibility?: Database["public"]["Enums"]["feedback_visibility"]
        }
        Relationships: [
          {
            foreignKeyName: "grader_result_output_assignment_group_id_fkey"
            columns: ["assignment_group_id"]
            isOneToOne: false
            referencedRelation: "assignment_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_result_output_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_result_output_grader_result_id_fkey"
            columns: ["grader_result_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["grader_result_id"]
          },
          {
            foreignKeyName: "grader_result_output_grader_result_id_fkey"
            columns: ["grader_result_id"]
            isOneToOne: false
            referencedRelation: "grader_results"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_result_output_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_result_output_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      grader_result_test_output: {
        Row: {
          class_id: number
          created_at: string
          extra_data: Json | null
          grader_result_test_id: number
          id: number
          output: string
          output_format: string
        }
        Insert: {
          class_id: number
          created_at?: string
          extra_data?: Json | null
          grader_result_test_id: number
          id?: number
          output: string
          output_format: string
        }
        Update: {
          class_id?: number
          created_at?: string
          extra_data?: Json | null
          grader_result_test_id?: number
          id?: number
          output?: string
          output_format?: string
        }
        Relationships: [
          {
            foreignKeyName: "grader_result_test_output_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_result_test_output_grader_result_test_id_fkey"
            columns: ["grader_result_test_id"]
            isOneToOne: false
            referencedRelation: "grader_result_tests"
            referencedColumns: ["id"]
          },
        ]
      }
      grader_result_tests: {
        Row: {
          assignment_group_id: number | null
          class_id: number
          created_at: string
          extra_data: Json | null
          grader_result_id: number
          id: number
          is_released: boolean
          max_score: number | null
          name: string
          name_format: string
          output: string | null
          output_format: string | null
          part: string | null
          score: number | null
          student_id: string | null
          submission_id: number | null
        }
        Insert: {
          assignment_group_id?: number | null
          class_id: number
          created_at?: string
          extra_data?: Json | null
          grader_result_id: number
          id?: number
          is_released?: boolean
          max_score?: number | null
          name: string
          name_format?: string
          output?: string | null
          output_format?: string | null
          part?: string | null
          score?: number | null
          student_id?: string | null
          submission_id?: number | null
        }
        Update: {
          assignment_group_id?: number | null
          class_id?: number
          created_at?: string
          extra_data?: Json | null
          grader_result_id?: number
          id?: number
          is_released?: boolean
          max_score?: number | null
          name?: string
          name_format?: string
          output?: string | null
          output_format?: string | null
          part?: string | null
          score?: number | null
          student_id?: string | null
          submission_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "grader_result_tests_assignment_group_id_fkey"
            columns: ["assignment_group_id"]
            isOneToOne: false
            referencedRelation: "assignment_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_result_tests_grader_result_id_fkey"
            columns: ["grader_result_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["grader_result_id"]
          },
          {
            foreignKeyName: "grader_result_tests_grader_result_id_fkey"
            columns: ["grader_result_id"]
            isOneToOne: false
            referencedRelation: "grader_results"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_result_tests_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_result_tests_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "grader_result_tests_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_result_tests_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_result_tests_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "grader_result_tests_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "grader_test_results_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      grader_result_tests_hint_feedback: {
        Row: {
          class_id: number
          comment: string | null
          created_at: string
          created_by: string
          grader_result_tests_id: number
          hint: string
          id: number
          submission_id: number
          useful: boolean
        }
        Insert: {
          class_id: number
          comment?: string | null
          created_at?: string
          created_by: string
          grader_result_tests_id: number
          hint: string
          id?: number
          submission_id: number
          useful: boolean
        }
        Update: {
          class_id?: number
          comment?: string | null
          created_at?: string
          created_by?: string
          grader_result_tests_id?: number
          hint?: string
          id?: number
          submission_id?: number
          useful?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "grader_result_tests_hint_feedback_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_result_tests_hint_feedback_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_result_tests_hint_feedback_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "grader_result_tests_hint_feedback_grader_result_tests_id_fkey"
            columns: ["grader_result_tests_id"]
            isOneToOne: false
            referencedRelation: "grader_result_tests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_result_tests_hint_feedback_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_result_tests_hint_feedback_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_result_tests_hint_feedback_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "grader_result_tests_hint_feedback_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["activesubmissionid"]
          },
        ]
      }
      grader_results: {
        Row: {
          assignment_group_id: number | null
          autograder_regression_test: number | null
          class_id: number
          created_at: string
          errors: Json | null
          execution_time: number | null
          grader_action_sha: string | null
          grader_sha: string | null
          id: number
          lint_output: string
          lint_output_format: string
          lint_passed: boolean
          max_score: number
          profile_id: string | null
          ret_code: number | null
          score: number
          submission_id: number | null
        }
        Insert: {
          assignment_group_id?: number | null
          autograder_regression_test?: number | null
          class_id: number
          created_at?: string
          errors?: Json | null
          execution_time?: number | null
          grader_action_sha?: string | null
          grader_sha?: string | null
          id?: number
          lint_output: string
          lint_output_format: string
          lint_passed: boolean
          max_score?: number
          profile_id?: string | null
          ret_code?: number | null
          score: number
          submission_id?: number | null
        }
        Update: {
          assignment_group_id?: number | null
          autograder_regression_test?: number | null
          class_id?: number
          created_at?: string
          errors?: Json | null
          execution_time?: number | null
          grader_action_sha?: string | null
          grader_sha?: string | null
          id?: number
          lint_output?: string
          lint_output_format?: string
          lint_passed?: boolean
          max_score?: number
          profile_id?: string | null
          ret_code?: number | null
          score?: number
          submission_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "grader_results_assignment_group_id_fkey"
            columns: ["assignment_group_id"]
            isOneToOne: false
            referencedRelation: "assignment_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_results_autograder_regression_test_fkey"
            columns: ["autograder_regression_test"]
            isOneToOne: false
            referencedRelation: "autograder_regression_test"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_results_autograder_regression_test_fkey"
            columns: ["autograder_regression_test"]
            isOneToOne: false
            referencedRelation: "autograder_regression_test_by_grader"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_results_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_results_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: true
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_results_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: true
            referencedRelation: "submissions_agg"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_results_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: true
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "grader_results_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: true
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "grader_results_user_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grader_results_user_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      grading_conflicts: {
        Row: {
          class_id: number
          created_at: string
          created_by_profile_id: string
          grader_profile_id: string
          id: number
          reason: string | null
          student_profile_id: string
        }
        Insert: {
          class_id: number
          created_at?: string
          created_by_profile_id: string
          grader_profile_id: string
          id?: number
          reason?: string | null
          student_profile_id: string
        }
        Update: {
          class_id?: number
          created_at?: string
          created_by_profile_id?: string
          grader_profile_id?: string
          id?: number
          reason?: string | null
          student_profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "grading_conflicts_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grading_conflicts_created_by_profile_id_fkey"
            columns: ["created_by_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grading_conflicts_created_by_profile_id_fkey"
            columns: ["created_by_profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "grading_conflicts_grader_profile_id_fkey"
            columns: ["grader_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grading_conflicts_grader_profile_id_fkey"
            columns: ["grader_profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "grading_conflicts_student_profile_id_fkey"
            columns: ["student_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grading_conflicts_student_profile_id_fkey"
            columns: ["student_profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      help_queue_assignments: {
        Row: {
          class_id: number
          ended_at: string | null
          help_queue_id: number
          id: number
          is_active: boolean
          max_concurrent_students: number
          started_at: string
          ta_profile_id: string
          updated_at: string
        }
        Insert: {
          class_id: number
          ended_at?: string | null
          help_queue_id: number
          id?: number
          is_active?: boolean
          max_concurrent_students?: number
          started_at?: string
          ta_profile_id: string
          updated_at?: string
        }
        Update: {
          class_id?: number
          ended_at?: string | null
          help_queue_id?: number
          id?: number
          is_active?: boolean
          max_concurrent_students?: number
          started_at?: string
          ta_profile_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "help_queue_assignments_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_queue_assignments_help_queue_id_fkey"
            columns: ["help_queue_id"]
            isOneToOne: false
            referencedRelation: "help_queues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_queue_assignments_ta_profile_id_fkey"
            columns: ["ta_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_queue_assignments_ta_profile_id_fkey"
            columns: ["ta_profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      help_queues: {
        Row: {
          available: boolean
          class_id: number
          closing_at: string | null
          color: string | null
          created_at: string
          depth: number
          description: string
          id: number
          is_active: boolean
          max_concurrent_requests: number | null
          name: string
          queue_type: Database["public"]["Enums"]["help_queue_type"]
          updated_at: string
        }
        Insert: {
          available?: boolean
          class_id: number
          closing_at?: string | null
          color?: string | null
          created_at?: string
          depth: number
          description: string
          id?: number
          is_active?: boolean
          max_concurrent_requests?: number | null
          name: string
          queue_type?: Database["public"]["Enums"]["help_queue_type"]
          updated_at?: string
        }
        Update: {
          available?: boolean
          class_id?: number
          closing_at?: string | null
          color?: string | null
          created_at?: string
          depth?: number
          description?: string
          id?: number
          is_active?: boolean
          max_concurrent_requests?: number | null
          name?: string
          queue_type?: Database["public"]["Enums"]["help_queue_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "help_queues_class_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      help_request_feedback: {
        Row: {
          class_id: number
          comment: string | null
          created_at: string
          help_request_id: number
          id: number
          student_profile_id: string
          thumbs_up: boolean
          updated_at: string
        }
        Insert: {
          class_id: number
          comment?: string | null
          created_at?: string
          help_request_id: number
          id?: number
          student_profile_id: string
          thumbs_up: boolean
          updated_at?: string
        }
        Update: {
          class_id?: number
          comment?: string | null
          created_at?: string
          help_request_id?: number
          id?: number
          student_profile_id?: string
          thumbs_up?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "help_request_feedback_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_feedback_help_request_id_fkey"
            columns: ["help_request_id"]
            isOneToOne: false
            referencedRelation: "help_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_feedback_student_profile_id_fkey"
            columns: ["student_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_feedback_student_profile_id_fkey"
            columns: ["student_profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      help_request_file_references: {
        Row: {
          assignment_id: number
          class_id: number
          created_at: string
          help_request_id: number
          id: number
          line_number: number | null
          submission_file_id: number | null
          submission_id: number | null
          updated_at: string
        }
        Insert: {
          assignment_id: number
          class_id: number
          created_at?: string
          help_request_id: number
          id?: number
          line_number?: number | null
          submission_file_id?: number | null
          submission_id?: number | null
          updated_at?: string
        }
        Update: {
          assignment_id?: number
          class_id?: number
          created_at?: string
          help_request_id?: number
          id?: number
          line_number?: number | null
          submission_file_id?: number | null
          submission_id?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "help_request_file_references_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_file_references_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_file_references_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_file_references_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_file_references_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "help_request_file_references_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_file_references_help_request_id_fkey"
            columns: ["help_request_id"]
            isOneToOne: false
            referencedRelation: "help_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_file_references_submission_file_id_fkey"
            columns: ["submission_file_id"]
            isOneToOne: false
            referencedRelation: "submission_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_file_references_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_file_references_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_file_references_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "help_request_file_references_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["activesubmissionid"]
          },
        ]
      }
      help_request_message_read_receipts: {
        Row: {
          class_id: number
          created_at: string
          help_request_id: number | null
          id: number
          message_id: number
          updated_at: string
          viewer_id: string
        }
        Insert: {
          class_id: number
          created_at?: string
          help_request_id?: number | null
          id?: number
          message_id: number
          updated_at?: string
          viewer_id: string
        }
        Update: {
          class_id?: number
          created_at?: string
          help_request_id?: number | null
          id?: number
          message_id?: number
          updated_at?: string
          viewer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "help_request_message_read_receipts_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_message_read_receipts_help_request_id_fkey"
            columns: ["help_request_id"]
            isOneToOne: false
            referencedRelation: "help_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_message_read_receipts_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "help_request_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_message_read_receipts_viewer_id_fkey"
            columns: ["viewer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_message_read_receipts_viewer_id_fkey"
            columns: ["viewer_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      help_request_messages: {
        Row: {
          author: string
          class_id: number
          created_at: string
          help_request_id: number
          id: number
          instructors_only: boolean
          message: string
          reply_to_message_id: number | null
          updated_at: string
        }
        Insert: {
          author: string
          class_id: number
          created_at?: string
          help_request_id: number
          id?: number
          instructors_only?: boolean
          message: string
          reply_to_message_id?: number | null
          updated_at?: string
        }
        Update: {
          author?: string
          class_id?: number
          created_at?: string
          help_request_id?: number
          id?: number
          instructors_only?: boolean
          message?: string
          reply_to_message_id?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "help_request_messages_author_fkey1"
            columns: ["author"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_messages_author_fkey1"
            columns: ["author"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "help_request_messages_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_messages_help_request_id_fkey"
            columns: ["help_request_id"]
            isOneToOne: false
            referencedRelation: "help_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_messages_reply_to_message_id_fkey"
            columns: ["reply_to_message_id"]
            isOneToOne: false
            referencedRelation: "help_request_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      help_request_moderation: {
        Row: {
          action_type: Database["public"]["Enums"]["moderation_action_type"]
          class_id: number
          created_at: string
          duration_minutes: number | null
          expires_at: string | null
          help_request_id: number
          id: number
          is_permanent: boolean
          message_id: number | null
          moderator_profile_id: string
          reason: string | null
          student_profile_id: string
          updated_at: string
        }
        Insert: {
          action_type: Database["public"]["Enums"]["moderation_action_type"]
          class_id: number
          created_at?: string
          duration_minutes?: number | null
          expires_at?: string | null
          help_request_id: number
          id?: number
          is_permanent?: boolean
          message_id?: number | null
          moderator_profile_id: string
          reason?: string | null
          student_profile_id: string
          updated_at?: string
        }
        Update: {
          action_type?: Database["public"]["Enums"]["moderation_action_type"]
          class_id?: number
          created_at?: string
          duration_minutes?: number | null
          expires_at?: string | null
          help_request_id?: number
          id?: number
          is_permanent?: boolean
          message_id?: number | null
          moderator_profile_id?: string
          reason?: string | null
          student_profile_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "help_request_moderation_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_moderation_help_request_id_fkey"
            columns: ["help_request_id"]
            isOneToOne: false
            referencedRelation: "help_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_moderation_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "help_request_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_moderation_moderator_profile_id_fkey"
            columns: ["moderator_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_moderation_moderator_profile_id_fkey"
            columns: ["moderator_profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "help_request_moderation_student_profile_id_fkey"
            columns: ["student_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_moderation_student_profile_id_fkey"
            columns: ["student_profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      help_request_students: {
        Row: {
          class_id: number
          created_at: string
          help_request_id: number
          id: number
          profile_id: string
          updated_at: string
        }
        Insert: {
          class_id: number
          created_at?: string
          help_request_id: number
          id?: number
          profile_id: string
          updated_at?: string
        }
        Update: {
          class_id?: number
          created_at?: string
          help_request_id?: number
          id?: number
          profile_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "help_request_students_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_students_help_request_id_fkey"
            columns: ["help_request_id"]
            isOneToOne: false
            referencedRelation: "help_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_students_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_students_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      help_request_templates: {
        Row: {
          category: string
          class_id: number
          created_at: string
          created_by_id: string
          description: string | null
          id: number
          is_active: boolean
          name: string
          template_content: string
          updated_at: string
          usage_count: number
        }
        Insert: {
          category: string
          class_id: number
          created_at?: string
          created_by_id: string
          description?: string | null
          id?: number
          is_active?: boolean
          name: string
          template_content: string
          updated_at?: string
          usage_count?: number
        }
        Update: {
          category?: string
          class_id?: number
          created_at?: string
          created_by_id?: string
          description?: string | null
          id?: number
          is_active?: boolean
          name?: string
          template_content?: string
          updated_at?: string
          usage_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "help_request_templates_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_templates_created_by_id_fkey"
            columns: ["created_by_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      help_request_watchers: {
        Row: {
          class_id: number
          created_at: string
          enabled: boolean
          help_request_id: number
          id: number
          user_id: string
        }
        Insert: {
          class_id: number
          created_at?: string
          enabled: boolean
          help_request_id: number
          id?: number
          user_id: string
        }
        Update: {
          class_id?: number
          created_at?: string
          enabled?: boolean
          help_request_id?: number
          id?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "help_request_watchers_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_watchers_help_request_id_fkey"
            columns: ["help_request_id"]
            isOneToOne: false
            referencedRelation: "help_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_watchers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      help_request_work_sessions: {
        Row: {
          class_id: number
          created_at: string
          ended_at: string | null
          help_request_id: number
          id: number
          longest_wait_seconds_at_start: number | null
          notes: string | null
          queue_depth_at_start: number | null
          started_at: string
          ta_profile_id: string
        }
        Insert: {
          class_id: number
          created_at?: string
          ended_at?: string | null
          help_request_id: number
          id?: number
          longest_wait_seconds_at_start?: number | null
          notes?: string | null
          queue_depth_at_start?: number | null
          started_at?: string
          ta_profile_id: string
        }
        Update: {
          class_id?: number
          created_at?: string
          ended_at?: string | null
          help_request_id?: number
          id?: number
          longest_wait_seconds_at_start?: number | null
          notes?: string | null
          queue_depth_at_start?: number | null
          started_at?: string
          ta_profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "help_request_work_sessions_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_work_sessions_help_request_id_fkey"
            columns: ["help_request_id"]
            isOneToOne: false
            referencedRelation: "help_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_work_sessions_ta_profile_id_fkey"
            columns: ["ta_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_request_work_sessions_ta_profile_id_fkey"
            columns: ["ta_profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      help_requests: {
        Row: {
          assignee: string | null
          class_id: number
          created_at: string
          created_by: string | null
          followup_to: number | null
          help_queue: number
          id: number
          is_private: boolean
          is_video_live: boolean
          location_type: Database["public"]["Enums"]["location_type"]
          referenced_submission_id: number | null
          request: string
          resolved_at: string | null
          resolved_by: string | null
          status: Database["public"]["Enums"]["help_request_status"]
          template_id: number | null
          updated_at: string
        }
        Insert: {
          assignee?: string | null
          class_id: number
          created_at?: string
          created_by?: string | null
          followup_to?: number | null
          help_queue: number
          id?: number
          is_private?: boolean
          is_video_live?: boolean
          location_type?: Database["public"]["Enums"]["location_type"]
          referenced_submission_id?: number | null
          request: string
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["help_request_status"]
          template_id?: number | null
          updated_at?: string
        }
        Update: {
          assignee?: string | null
          class_id?: number
          created_at?: string
          created_by?: string | null
          followup_to?: number | null
          help_queue?: number
          id?: number
          is_private?: boolean
          is_video_live?: boolean
          location_type?: Database["public"]["Enums"]["location_type"]
          referenced_submission_id?: number | null
          request?: string
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["help_request_status"]
          template_id?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "help_requests_assignee_fkey"
            columns: ["assignee"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_requests_assignee_fkey"
            columns: ["assignee"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "help_requests_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_requests_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_requests_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "help_requests_help_queue_fkey"
            columns: ["help_queue"]
            isOneToOne: false
            referencedRelation: "help_queues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_requests_referenced_submission_id_fkey"
            columns: ["referenced_submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_requests_referenced_submission_id_fkey"
            columns: ["referenced_submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_requests_referenced_submission_id_fkey"
            columns: ["referenced_submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "help_requests_referenced_submission_id_fkey"
            columns: ["referenced_submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "help_requests_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_requests_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "help_requests_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "help_request_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      invitations: {
        Row: {
          accepted_at: string | null
          class_id: number
          class_section_id: number | null
          created_at: string
          email: string | null
          expires_at: string | null
          id: number
          invited_by: string | null
          lab_section_id: number | null
          name: string | null
          private_profile_id: string
          public_profile_id: string
          role: Database["public"]["Enums"]["app_role"]
          sis_managed: boolean
          sis_user_id: number
          status: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          accepted_at?: string | null
          class_id: number
          class_section_id?: number | null
          created_at?: string
          email?: string | null
          expires_at?: string | null
          id?: number
          invited_by?: string | null
          lab_section_id?: number | null
          name?: string | null
          private_profile_id: string
          public_profile_id: string
          role: Database["public"]["Enums"]["app_role"]
          sis_managed?: boolean
          sis_user_id: number
          status?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          accepted_at?: string | null
          class_id?: number
          class_section_id?: number | null
          created_at?: string
          email?: string | null
          expires_at?: string | null
          id?: number
          invited_by?: string | null
          lab_section_id?: number | null
          name?: string | null
          private_profile_id?: string
          public_profile_id?: string
          role?: Database["public"]["Enums"]["app_role"]
          sis_managed?: boolean
          sis_user_id?: number
          status?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_invitations_class_id"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_invitations_class_section_id"
            columns: ["class_section_id"]
            isOneToOne: false
            referencedRelation: "class_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_invitations_invited_by"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "fk_invitations_lab_section_id"
            columns: ["lab_section_id"]
            isOneToOne: false
            referencedRelation: "lab_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_invitations_private_profile_id"
            columns: ["private_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_invitations_private_profile_id"
            columns: ["private_profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "fk_invitations_public_profile_id"
            columns: ["public_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_invitations_public_profile_id"
            columns: ["public_profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      lab_section_leaders: {
        Row: {
          class_id: number
          created_at: string
          id: number
          lab_section_id: number
          profile_id: string
        }
        Insert: {
          class_id: number
          created_at?: string
          id?: number
          lab_section_id: number
          profile_id: string
        }
        Update: {
          class_id?: number
          created_at?: string
          id?: number
          lab_section_id?: number
          profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lab_section_leaders_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_section_leaders_lab_section_id_fkey"
            columns: ["lab_section_id"]
            isOneToOne: false
            referencedRelation: "lab_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_section_leaders_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_section_leaders_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      lab_section_meetings: {
        Row: {
          cancelled: boolean
          class_id: number
          created_at: string
          id: number
          lab_section_id: number
          meeting_date: string
          notes: string | null
          updated_at: string
        }
        Insert: {
          cancelled?: boolean
          class_id: number
          created_at?: string
          id?: number
          lab_section_id: number
          meeting_date: string
          notes?: string | null
          updated_at?: string
        }
        Update: {
          cancelled?: boolean
          class_id?: number
          created_at?: string
          id?: number
          lab_section_id?: number
          meeting_date?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lab_section_meetings_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_section_meetings_lab_section_id_fkey"
            columns: ["lab_section_id"]
            isOneToOne: false
            referencedRelation: "lab_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      lab_sections: {
        Row: {
          campus: string | null
          class_id: number
          created_at: string
          day_of_week: Database["public"]["Enums"]["day_of_week"] | null
          description: string | null
          end_time: string | null
          id: number
          meeting_location: string | null
          meeting_times: string | null
          name: string
          sis_crn: number | null
          start_time: string | null
          updated_at: string
        }
        Insert: {
          campus?: string | null
          class_id: number
          created_at?: string
          day_of_week?: Database["public"]["Enums"]["day_of_week"] | null
          description?: string | null
          end_time?: string | null
          id?: number
          meeting_location?: string | null
          meeting_times?: string | null
          name: string
          sis_crn?: number | null
          start_time?: string | null
          updated_at?: string
        }
        Update: {
          campus?: string | null
          class_id?: number
          created_at?: string
          day_of_week?: Database["public"]["Enums"]["day_of_week"] | null
          description?: string | null
          end_time?: string | null
          id?: number
          meeting_location?: string | null
          meeting_times?: string | null
          name?: string
          sis_crn?: number | null
          start_time?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lab_sections_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      live_poll_responses: {
        Row: {
          created_at: string
          id: string
          is_submitted: boolean
          live_poll_id: string
          public_profile_id: string | null
          response: Json
          submitted_at: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          is_submitted?: boolean
          live_poll_id: string
          public_profile_id?: string | null
          response?: Json
          submitted_at?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          is_submitted?: boolean
          live_poll_id?: string
          public_profile_id?: string | null
          response?: Json
          submitted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "live_poll_responses_live_poll_id_fkey"
            columns: ["live_poll_id"]
            isOneToOne: false
            referencedRelation: "live_polls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_poll_responses_public_profile_id_fkey"
            columns: ["public_profile_id"]
            isOneToOne: false
            referencedRelation: "user_roles"
            referencedColumns: ["public_profile_id"]
          },
        ]
      }
      live_polls: {
        Row: {
          class_id: number
          created_at: string
          created_by: string
          deactivates_at: string | null
          id: string
          is_live: boolean
          question: Json
          require_login: boolean
        }
        Insert: {
          class_id: number
          created_at?: string
          created_by: string
          deactivates_at?: string | null
          id?: string
          is_live?: boolean
          question?: Json
          require_login?: boolean
        }
        Update: {
          class_id?: number
          created_at?: string
          created_by?: string
          deactivates_at?: string | null
          id?: string
          is_live?: boolean
          question?: Json
          require_login?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "live_polls_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_polls_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_roles"
            referencedColumns: ["public_profile_id"]
          },
        ]
      }
      llm_inference_usage: {
        Row: {
          account: string
          class_id: number
          created_at: string
          created_by: string
          grader_result_test_id: number
          id: number
          input_tokens: number
          model: string
          output_tokens: number
          provider: string
          submission_id: number
          tags: Json
        }
        Insert: {
          account: string
          class_id: number
          created_at?: string
          created_by: string
          grader_result_test_id: number
          id?: number
          input_tokens: number
          model: string
          output_tokens: number
          provider: string
          submission_id: number
          tags?: Json
        }
        Update: {
          account?: string
          class_id?: number
          created_at?: string
          created_by?: string
          grader_result_test_id?: number
          id?: number
          input_tokens?: number
          model?: string
          output_tokens?: number
          provider?: string
          submission_id?: number
          tags?: Json
        }
        Relationships: [
          {
            foreignKeyName: "llm_inference_usage_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "llm_inference_usage_grader_result_test_id_fkey"
            columns: ["grader_result_test_id"]
            isOneToOne: false
            referencedRelation: "grader_result_tests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "llm_inference_usage_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "llm_inference_usage_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "llm_inference_usage_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "llm_inference_usage_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["activesubmissionid"]
          },
        ]
      }
      name_generation_words: {
        Row: {
          id: number
          is_adjective: boolean
          is_noun: boolean
          word: string
        }
        Insert: {
          id?: number
          is_adjective: boolean
          is_noun: boolean
          word: string
        }
        Update: {
          id?: number
          is_adjective?: boolean
          is_noun?: boolean
          word?: string
        }
        Relationships: []
      }
      notification_preferences: {
        Row: {
          class_id: number
          created_at: string
          discussion_notification: Database["public"]["Enums"]["discussion_notification_type"]
          help_request_creation_notification: Database["public"]["Enums"]["help_request_creation_notification"]
          id: number
          regrade_request_notification: Database["public"]["Enums"]["help_request_creation_notification"]
          updated_at: string
          user_id: string
        }
        Insert: {
          class_id: number
          created_at?: string
          discussion_notification?: Database["public"]["Enums"]["discussion_notification_type"]
          help_request_creation_notification: Database["public"]["Enums"]["help_request_creation_notification"]
          id?: number
          regrade_request_notification?: Database["public"]["Enums"]["help_request_creation_notification"]
          updated_at?: string
          user_id: string
        }
        Update: {
          class_id?: number
          created_at?: string
          discussion_notification?: Database["public"]["Enums"]["discussion_notification_type"]
          help_request_creation_notification?: Database["public"]["Enums"]["help_request_creation_notification"]
          id?: number
          regrade_request_notification?: Database["public"]["Enums"]["help_request_creation_notification"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_preferences_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: Json
          class_id: number
          created_at: string
          id: number
          style: string | null
          subject: Json
          updated_at: string
          user_id: string
          viewed_at: string | null
        }
        Insert: {
          body: Json
          class_id: number
          created_at?: string
          id?: number
          style?: string | null
          subject: Json
          updated_at?: string
          user_id: string
          viewed_at?: string | null
        }
        Update: {
          body?: Json
          class_id?: number
          created_at?: string
          id?: number
          style?: string | null
          subject?: Json
          updated_at?: string
          user_id?: string
          viewed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notifications_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      permissions: {
        Row: {
          created_at: string
          id: number
          permission: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: number
          permission?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: number
          permission?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          class_id: number
          created_at: string
          flair: string | null
          flair_color: string | null
          id: string
          is_private_profile: boolean
          name: string | null
          short_name: string | null
          sortable_name: string | null
          time_zone: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          class_id: number
          created_at?: string
          flair?: string | null
          flair_color?: string | null
          id?: string
          is_private_profile: boolean
          name?: string | null
          short_name?: string | null
          sortable_name?: string | null
          time_zone?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          class_id?: number
          created_at?: string
          flair?: string | null
          flair_color?: string | null
          id?: string
          is_private_profile?: boolean
          name?: string | null
          short_name?: string | null
          sortable_name?: string | null
          time_zone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      realtime_channel_subscriptions: {
        Row: {
          channel: string
          class_id: number | null
          client_id: string
          created_at: string
          lease_expires_at: string
          profile_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          channel: string
          class_id?: number | null
          client_id: string
          created_at?: string
          lease_expires_at: string
          profile_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          channel?: string
          class_id?: number | null
          client_id?: string
          created_at?: string
          lease_expires_at?: string
          profile_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      repositories: {
        Row: {
          assignment_group_id: number | null
          assignment_id: number
          class_id: number
          created_at: string
          desired_handout_sha: string | null
          id: number
          is_github_ready: boolean
          profile_id: string | null
          repository: string
          rerun_queued_at: string | null
          sync_data: Json | null
          synced_handout_sha: string | null
          synced_repo_sha: string | null
          updated_at: string
        }
        Insert: {
          assignment_group_id?: number | null
          assignment_id: number
          class_id: number
          created_at?: string
          desired_handout_sha?: string | null
          id?: number
          is_github_ready?: boolean
          profile_id?: string | null
          repository: string
          rerun_queued_at?: string | null
          sync_data?: Json | null
          synced_handout_sha?: string | null
          synced_repo_sha?: string | null
          updated_at?: string
        }
        Update: {
          assignment_group_id?: number | null
          assignment_id?: number
          class_id?: number
          created_at?: string
          desired_handout_sha?: string | null
          id?: number
          is_github_ready?: boolean
          profile_id?: string | null
          repository?: string
          rerun_queued_at?: string | null
          sync_data?: Json | null
          synced_handout_sha?: string | null
          synced_repo_sha?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "repositories_assignment_group_id_fkey"
            columns: ["assignment_group_id"]
            isOneToOne: false
            referencedRelation: "assignment_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repositories_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repositories_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repositories_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repositories_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repositories_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "repositories_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repositories_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["student_profile_id"]
          },
          {
            foreignKeyName: "repositories_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "repositories_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "user_roles"
            referencedColumns: ["private_profile_id"]
          },
          {
            foreignKeyName: "repositories_user_id_fkey1"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repositories_user_id_fkey1"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      repository_check_runs: {
        Row: {
          assignment_group_id: number | null
          check_run_id: number
          class_id: number
          commit_message: string
          created_at: string
          id: number
          profile_id: string | null
          repository_id: number
          sha: string
          status: Json
          triggered_by: string | null
        }
        Insert: {
          assignment_group_id?: number | null
          check_run_id: number
          class_id: number
          commit_message: string
          created_at?: string
          id?: number
          profile_id?: string | null
          repository_id: number
          sha: string
          status: Json
          triggered_by?: string | null
        }
        Update: {
          assignment_group_id?: number | null
          check_run_id?: number
          class_id?: number
          commit_message?: string
          created_at?: string
          id?: number
          profile_id?: string | null
          repository_id?: number
          sha?: string
          status?: Json
          triggered_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "repository_check_run_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repository_check_run_repository_id_fkey"
            columns: ["repository_id"]
            isOneToOne: false
            referencedRelation: "repositories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repository_check_runs_assignment_group_id_fkey"
            columns: ["assignment_group_id"]
            isOneToOne: false
            referencedRelation: "assignment_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repository_check_runs_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repository_check_runs_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "repository_check_runs_triggered_by_fkey"
            columns: ["triggered_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repository_check_runs_triggered_by_fkey"
            columns: ["triggered_by"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "repository_check_runs_triggered_by_fkey1"
            columns: ["triggered_by"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["student_profile_id"]
          },
          {
            foreignKeyName: "repository_check_runs_triggered_by_fkey1"
            columns: ["triggered_by"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "repository_check_runs_triggered_by_fkey1"
            columns: ["triggered_by"]
            isOneToOne: false
            referencedRelation: "user_roles"
            referencedColumns: ["private_profile_id"]
          },
        ]
      }
      review_assignment_rubric_parts: {
        Row: {
          class_id: number
          created_at: string
          id: number
          review_assignment_id: number
          rubric_part_id: number
          updated_at: string
        }
        Insert: {
          class_id: number
          created_at?: string
          id?: number
          review_assignment_id: number
          rubric_part_id: number
          updated_at?: string
        }
        Update: {
          class_id?: number
          created_at?: string
          id?: number
          review_assignment_id?: number
          rubric_part_id?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_assignment_rubric_parts_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_assignment_rubric_parts_review_assignment_id_fkey"
            columns: ["review_assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["review_assignment_id"]
          },
          {
            foreignKeyName: "review_assignment_rubric_parts_review_assignment_id_fkey"
            columns: ["review_assignment_id"]
            isOneToOne: false
            referencedRelation: "review_assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_assignment_rubric_parts_rubric_part_id_fkey"
            columns: ["rubric_part_id"]
            isOneToOne: false
            referencedRelation: "rubric_parts"
            referencedColumns: ["id"]
          },
        ]
      }
      review_assignments: {
        Row: {
          assignee_profile_id: string
          assignment_id: number
          class_id: number
          completed_at: string | null
          completed_by: string | null
          created_at: string
          due_date: string
          hard_deadline: boolean
          id: number
          max_allowable_late_tokens: number
          release_date: string | null
          rubric_id: number
          submission_id: number
          submission_review_id: number
          updated_at: string
        }
        Insert: {
          assignee_profile_id: string
          assignment_id: number
          class_id: number
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          due_date: string
          hard_deadline?: boolean
          id?: number
          max_allowable_late_tokens?: number
          release_date?: string | null
          rubric_id: number
          submission_id: number
          submission_review_id: number
          updated_at?: string
        }
        Update: {
          assignee_profile_id?: string
          assignment_id?: number
          class_id?: number
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          due_date?: string
          hard_deadline?: boolean
          id?: number
          max_allowable_late_tokens?: number
          release_date?: string | null
          rubric_id?: number
          submission_id?: number
          submission_review_id?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_assignments_assignee_profile_id_fkey"
            columns: ["assignee_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_assignments_assignee_profile_id_fkey"
            columns: ["assignee_profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "review_assignments_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_assignments_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_assignments_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_assignments_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_assignments_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "review_assignments_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_assignments_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_assignments_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "review_assignments_rubric_id_fkey"
            columns: ["rubric_id"]
            isOneToOne: false
            referencedRelation: "rubrics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_assignments_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_assignments_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_assignments_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "review_assignments_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "review_assignments_submission_review_id_fkey"
            columns: ["submission_review_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["submission_review_id"]
          },
          {
            foreignKeyName: "review_assignments_submission_review_id_fkey"
            columns: ["submission_review_id"]
            isOneToOne: false
            referencedRelation: "submission_reviews"
            referencedColumns: ["id"]
          },
        ]
      }
      rubric_check_references: {
        Row: {
          assignment_id: number
          class_id: number
          created_at: string
          id: number
          referenced_rubric_check_id: number
          referencing_rubric_check_id: number
          rubric_id: number
        }
        Insert: {
          assignment_id: number
          class_id: number
          created_at?: string
          id?: number
          referenced_rubric_check_id: number
          referencing_rubric_check_id: number
          rubric_id: number
        }
        Update: {
          assignment_id?: number
          class_id?: number
          created_at?: string
          id?: number
          referenced_rubric_check_id?: number
          referencing_rubric_check_id?: number
          rubric_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "rubric_check_references_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_check_references_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_check_references_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_check_references_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_check_references_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "rubric_check_references_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_check_references_referenced_rubric_check_id_fkey"
            columns: ["referenced_rubric_check_id"]
            isOneToOne: false
            referencedRelation: "rubric_checks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_check_references_referencing_rubric_check_id_fkey"
            columns: ["referencing_rubric_check_id"]
            isOneToOne: false
            referencedRelation: "rubric_checks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_check_references_rubric_id_fkey"
            columns: ["rubric_id"]
            isOneToOne: false
            referencedRelation: "rubrics"
            referencedColumns: ["id"]
          },
        ]
      }
      rubric_checks: {
        Row: {
          annotation_target: string | null
          artifact: string | null
          assignment_id: number
          class_id: number
          created_at: string
          data: Json | null
          description: string | null
          file: string | null
          group: string | null
          id: number
          is_annotation: boolean
          is_comment_required: boolean
          is_required: boolean
          max_annotations: number | null
          name: string
          ordinal: number
          points: number
          rubric_criteria_id: number
          rubric_id: number
          student_visibility: Database["public"]["Enums"]["rubric_check_student_visibility"]
        }
        Insert: {
          annotation_target?: string | null
          artifact?: string | null
          assignment_id: number
          class_id: number
          created_at?: string
          data?: Json | null
          description?: string | null
          file?: string | null
          group?: string | null
          id?: number
          is_annotation: boolean
          is_comment_required?: boolean
          is_required?: boolean
          max_annotations?: number | null
          name: string
          ordinal: number
          points: number
          rubric_criteria_id: number
          rubric_id: number
          student_visibility?: Database["public"]["Enums"]["rubric_check_student_visibility"]
        }
        Update: {
          annotation_target?: string | null
          artifact?: string | null
          assignment_id?: number
          class_id?: number
          created_at?: string
          data?: Json | null
          description?: string | null
          file?: string | null
          group?: string | null
          id?: number
          is_annotation?: boolean
          is_comment_required?: boolean
          is_required?: boolean
          max_annotations?: number | null
          name?: string
          ordinal?: number
          points?: number
          rubric_criteria_id?: number
          rubric_id?: number
          student_visibility?: Database["public"]["Enums"]["rubric_check_student_visibility"]
        }
        Relationships: [
          {
            foreignKeyName: "rubric_checks_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_checks_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_checks_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_checks_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_checks_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "rubric_checks_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_checks_rubric_criteria_id_fkey"
            columns: ["rubric_criteria_id"]
            isOneToOne: false
            referencedRelation: "rubric_criteria"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_checks_rubric_id_fkey"
            columns: ["rubric_id"]
            isOneToOne: false
            referencedRelation: "rubrics"
            referencedColumns: ["id"]
          },
        ]
      }
      rubric_criteria: {
        Row: {
          assignment_id: number
          class_id: number
          created_at: string
          data: Json | null
          description: string | null
          id: number
          is_additive: boolean
          max_checks_per_submission: number | null
          min_checks_per_submission: number | null
          name: string
          ordinal: number
          rubric_id: number
          rubric_part_id: number
          total_points: number
        }
        Insert: {
          assignment_id: number
          class_id: number
          created_at?: string
          data?: Json | null
          description?: string | null
          id?: number
          is_additive: boolean
          max_checks_per_submission?: number | null
          min_checks_per_submission?: number | null
          name: string
          ordinal?: number
          rubric_id: number
          rubric_part_id: number
          total_points: number
        }
        Update: {
          assignment_id?: number
          class_id?: number
          created_at?: string
          data?: Json | null
          description?: string | null
          id?: number
          is_additive?: boolean
          max_checks_per_submission?: number | null
          min_checks_per_submission?: number | null
          name?: string
          ordinal?: number
          rubric_id?: number
          rubric_part_id?: number
          total_points?: number
        }
        Relationships: [
          {
            foreignKeyName: "rubric_criteria_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_criteria_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_criteria_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_criteria_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_criteria_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "rubric_criteria_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_criteria_rubric_id_fkey"
            columns: ["rubric_id"]
            isOneToOne: false
            referencedRelation: "rubrics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_criteria_rubric_part_id_fkey"
            columns: ["rubric_part_id"]
            isOneToOne: false
            referencedRelation: "rubric_parts"
            referencedColumns: ["id"]
          },
        ]
      }
      rubric_parts: {
        Row: {
          assignment_id: number
          class_id: number
          created_at: string
          data: Json | null
          description: string | null
          id: number
          name: string
          ordinal: number
          rubric_id: number
        }
        Insert: {
          assignment_id: number
          class_id: number
          created_at?: string
          data?: Json | null
          description?: string | null
          id?: number
          name: string
          ordinal: number
          rubric_id: number
        }
        Update: {
          assignment_id?: number
          class_id?: number
          created_at?: string
          data?: Json | null
          description?: string | null
          id?: number
          name?: string
          ordinal?: number
          rubric_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "rubric_parts_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_parts_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_parts_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_parts_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_parts_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "rubric_parts_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubric_parts_rubric_id_fkey"
            columns: ["rubric_id"]
            isOneToOne: false
            referencedRelation: "rubrics"
            referencedColumns: ["id"]
          },
        ]
      }
      rubrics: {
        Row: {
          assignment_id: number
          class_id: number
          created_at: string
          description: string | null
          id: number
          is_private: boolean
          name: string
          review_round: Database["public"]["Enums"]["review_round"] | null
        }
        Insert: {
          assignment_id: number
          class_id: number
          created_at?: string
          description?: string | null
          id?: number
          is_private?: boolean
          name: string
          review_round?: Database["public"]["Enums"]["review_round"] | null
        }
        Update: {
          assignment_id?: number
          class_id?: number
          created_at?: string
          description?: string | null
          id?: number
          is_private?: boolean
          name?: string
          review_round?: Database["public"]["Enums"]["review_round"] | null
        }
        Relationships: [
          {
            foreignKeyName: "assignment_rubric_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubrics_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubrics_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubrics_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubrics_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rubrics_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
        ]
      }
      sis_sync_status: {
        Row: {
          course_id: number
          course_section_id: number | null
          created_at: string
          id: number
          lab_section_id: number | null
          last_sync_message: string | null
          last_sync_status: string | null
          last_sync_time: string | null
          sync_enabled: boolean
        }
        Insert: {
          course_id: number
          course_section_id?: number | null
          created_at?: string
          id?: number
          lab_section_id?: number | null
          last_sync_message?: string | null
          last_sync_status?: string | null
          last_sync_time?: string | null
          sync_enabled?: boolean
        }
        Update: {
          course_id?: number
          course_section_id?: number | null
          created_at?: string
          id?: number
          lab_section_id?: number | null
          last_sync_message?: string | null
          last_sync_status?: string | null
          last_sync_time?: string | null
          sync_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "sis_sync_status_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sis_sync_status_course_section_id_fkey"
            columns: ["course_section_id"]
            isOneToOne: false
            referencedRelation: "class_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sis_sync_status_lab_section_id_fkey"
            columns: ["lab_section_id"]
            isOneToOne: false
            referencedRelation: "lab_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      student_deadline_extensions: {
        Row: {
          class_id: number
          created_at: string
          hours: number
          id: number
          includes_lab: boolean
          student_id: string
          updated_at: string
        }
        Insert: {
          class_id: number
          created_at?: string
          hours: number
          id?: number
          includes_lab?: boolean
          student_id: string
          updated_at?: string
        }
        Update: {
          class_id?: number
          created_at?: string
          hours?: number
          id?: number
          includes_lab?: boolean
          student_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "student_deadline_extensions_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_deadline_extensions_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_deadline_extensions_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      student_flashcard_deck_progress: {
        Row: {
          card_id: number
          class_id: number
          created_at: string
          first_answered_correctly_at: string | null
          is_mastered: boolean
          last_answered_correctly_at: string | null
          student_id: string
          updated_at: string | null
        }
        Insert: {
          card_id: number
          class_id: number
          created_at?: string
          first_answered_correctly_at?: string | null
          is_mastered?: boolean
          last_answered_correctly_at?: string | null
          student_id: string
          updated_at?: string | null
        }
        Update: {
          card_id?: number
          class_id?: number
          created_at?: string
          first_answered_correctly_at?: string | null
          is_mastered?: boolean
          last_answered_correctly_at?: string | null
          student_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "student_flashcard_deck_progress_card_id_fkey"
            columns: ["card_id"]
            isOneToOne: false
            referencedRelation: "flashcards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_flashcard_deck_progress_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_flashcard_deck_progress_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      student_help_activity: {
        Row: {
          activity_description: string | null
          activity_type: Database["public"]["Enums"]["student_help_activity_type"]
          class_id: number
          created_at: string
          help_request_id: number
          id: number
          student_profile_id: string
          updated_at: string
        }
        Insert: {
          activity_description?: string | null
          activity_type: Database["public"]["Enums"]["student_help_activity_type"]
          class_id: number
          created_at?: string
          help_request_id: number
          id?: number
          student_profile_id: string
          updated_at?: string
        }
        Update: {
          activity_description?: string | null
          activity_type?: Database["public"]["Enums"]["student_help_activity_type"]
          class_id?: number
          created_at?: string
          help_request_id?: number
          id?: number
          student_profile_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "student_help_activity_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_help_activity_help_request_id_fkey"
            columns: ["help_request_id"]
            isOneToOne: false
            referencedRelation: "help_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_help_activity_student_profile_id_fkey"
            columns: ["student_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_help_activity_student_profile_id_fkey"
            columns: ["student_profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      student_karma_notes: {
        Row: {
          class_id: number
          created_at: string
          created_by_id: string
          id: number
          internal_notes: string | null
          karma_score: number
          last_activity_at: string | null
          student_profile_id: string
          updated_at: string
        }
        Insert: {
          class_id: number
          created_at?: string
          created_by_id: string
          id?: number
          internal_notes?: string | null
          karma_score?: number
          last_activity_at?: string | null
          student_profile_id: string
          updated_at?: string
        }
        Update: {
          class_id?: number
          created_at?: string
          created_by_id?: string
          id?: number
          internal_notes?: string | null
          karma_score?: number
          last_activity_at?: string | null
          student_profile_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "student_karma_notes_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_karma_notes_created_by_id_fkey"
            columns: ["created_by_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "student_karma_notes_student_profile_id_fkey"
            columns: ["student_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_karma_notes_student_profile_id_fkey"
            columns: ["student_profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      submission_artifact_comments: {
        Row: {
          author: string
          class_id: number
          comment: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          edited_by: string | null
          eventually_visible: boolean
          id: number
          points: number | null
          regrade_request_id: number | null
          released: boolean
          rubric_check_id: number | null
          submission_artifact_id: number
          submission_id: number
          submission_review_id: number | null
          updated_at: string
        }
        Insert: {
          author: string
          class_id: number
          comment: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          edited_by?: string | null
          eventually_visible?: boolean
          id?: number
          points?: number | null
          regrade_request_id?: number | null
          released?: boolean
          rubric_check_id?: number | null
          submission_artifact_id: number
          submission_id: number
          submission_review_id?: number | null
          updated_at?: string
        }
        Update: {
          author?: string
          class_id?: number
          comment?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          edited_by?: string | null
          eventually_visible?: boolean
          id?: number
          points?: number | null
          regrade_request_id?: number | null
          released?: boolean
          rubric_check_id?: number | null
          submission_artifact_id?: number
          submission_id?: number
          submission_review_id?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "submission_artifact_comments_author_fkey"
            columns: ["author"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifact_comments_author_fkey"
            columns: ["author"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "submission_artifact_comments_author_fkey1"
            columns: ["author"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifact_comments_author_fkey1"
            columns: ["author"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "submission_artifact_comments_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifact_comments_class_id_fkey1"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifact_comments_regrade_request_id_fkey"
            columns: ["regrade_request_id"]
            isOneToOne: false
            referencedRelation: "submission_regrade_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifact_comments_rubric_check_id_fkey"
            columns: ["rubric_check_id"]
            isOneToOne: false
            referencedRelation: "rubric_checks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifact_comments_rubric_check_id_fkey1"
            columns: ["rubric_check_id"]
            isOneToOne: false
            referencedRelation: "rubric_checks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_artifact_id_fkey"
            columns: ["submission_artifact_id"]
            isOneToOne: false
            referencedRelation: "submission_artifacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_id_fkey1"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_id_fkey1"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_id_fkey1"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_id_fkey1"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_review_id_fkey"
            columns: ["submission_review_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["submission_review_id"]
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_review_id_fkey"
            columns: ["submission_review_id"]
            isOneToOne: false
            referencedRelation: "submission_reviews"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_review_id_fkey1"
            columns: ["submission_review_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["submission_review_id"]
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_review_id_fkey1"
            columns: ["submission_review_id"]
            isOneToOne: false
            referencedRelation: "submission_reviews"
            referencedColumns: ["id"]
          },
        ]
      }
      submission_artifacts: {
        Row: {
          assignment_group_id: number | null
          autograder_regression_test_id: number | null
          class_id: number
          created_at: string
          data: Json | null
          id: number
          name: string
          profile_id: string | null
          submission_file_id: number | null
          submission_id: number
        }
        Insert: {
          assignment_group_id?: number | null
          autograder_regression_test_id?: number | null
          class_id: number
          created_at?: string
          data?: Json | null
          id?: number
          name: string
          profile_id?: string | null
          submission_file_id?: number | null
          submission_id: number
        }
        Update: {
          assignment_group_id?: number | null
          autograder_regression_test_id?: number | null
          class_id?: number
          created_at?: string
          data?: Json | null
          id?: number
          name?: string
          profile_id?: string | null
          submission_file_id?: number | null
          submission_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "submission_artifacts_assignment_group_id_fkey"
            columns: ["assignment_group_id"]
            isOneToOne: false
            referencedRelation: "assignment_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifacts_autograder_regression_test_id_fkey"
            columns: ["autograder_regression_test_id"]
            isOneToOne: false
            referencedRelation: "autograder_regression_test"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifacts_autograder_regression_test_id_fkey"
            columns: ["autograder_regression_test_id"]
            isOneToOne: false
            referencedRelation: "autograder_regression_test_by_grader"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifacts_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifacts_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifacts_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "submission_artifacts_submission_file_id_fkey"
            columns: ["submission_file_id"]
            isOneToOne: false
            referencedRelation: "submission_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifacts_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifacts_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_artifacts_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "submission_artifacts_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["activesubmissionid"]
          },
        ]
      }
      submission_comments: {
        Row: {
          author: string
          class_id: number
          comment: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          edited_by: string | null
          eventually_visible: boolean
          id: number
          points: number | null
          regrade_request_id: number | null
          released: boolean
          rubric_check_id: number | null
          submission_id: number
          submission_review_id: number | null
          updated_at: string
        }
        Insert: {
          author: string
          class_id: number
          comment: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          edited_by?: string | null
          eventually_visible?: boolean
          id?: number
          points?: number | null
          regrade_request_id?: number | null
          released?: boolean
          rubric_check_id?: number | null
          submission_id: number
          submission_review_id?: number | null
          updated_at?: string
        }
        Update: {
          author?: string
          class_id?: number
          comment?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          edited_by?: string | null
          eventually_visible?: boolean
          id?: number
          points?: number | null
          regrade_request_id?: number | null
          released?: boolean
          rubric_check_id?: number | null
          submission_id?: number
          submission_review_id?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "submission_comments_author_fkey"
            columns: ["author"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_comments_author_fkey"
            columns: ["author"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "submission_comments_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_comments_regrade_request_id_fkey"
            columns: ["regrade_request_id"]
            isOneToOne: false
            referencedRelation: "submission_regrade_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_comments_rubric_check_id_fkey"
            columns: ["rubric_check_id"]
            isOneToOne: false
            referencedRelation: "rubric_checks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_comments_submission_review_id_fkey"
            columns: ["submission_review_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["submission_review_id"]
          },
          {
            foreignKeyName: "submission_comments_submission_review_id_fkey"
            columns: ["submission_review_id"]
            isOneToOne: false
            referencedRelation: "submission_reviews"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_comments_submissions_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_comments_submissions_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_comments_submissions_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "submission_comments_submissions_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["activesubmissionid"]
          },
        ]
      }
      submission_file_comments: {
        Row: {
          author: string
          class_id: number
          comment: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          edited_by: string | null
          eventually_visible: boolean
          id: number
          line: number
          points: number | null
          regrade_request_id: number | null
          released: boolean
          rubric_check_id: number | null
          submission_file_id: number
          submission_id: number
          submission_review_id: number | null
          updated_at: string
        }
        Insert: {
          author: string
          class_id: number
          comment: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          edited_by?: string | null
          eventually_visible?: boolean
          id?: number
          line: number
          points?: number | null
          regrade_request_id?: number | null
          released?: boolean
          rubric_check_id?: number | null
          submission_file_id: number
          submission_id: number
          submission_review_id?: number | null
          updated_at?: string
        }
        Update: {
          author?: string
          class_id?: number
          comment?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          edited_by?: string | null
          eventually_visible?: boolean
          id?: number
          line?: number
          points?: number | null
          regrade_request_id?: number | null
          released?: boolean
          rubric_check_id?: number | null
          submission_file_id?: number
          submission_id?: number
          submission_review_id?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "submission_file_comments_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_file_comments_regrade_request_id_fkey"
            columns: ["regrade_request_id"]
            isOneToOne: false
            referencedRelation: "submission_regrade_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_file_comments_rubric_check_id_fkey"
            columns: ["rubric_check_id"]
            isOneToOne: false
            referencedRelation: "rubric_checks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_file_comments_submission_review_id_fkey"
            columns: ["submission_review_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["submission_review_id"]
          },
          {
            foreignKeyName: "submission_file_comments_submission_review_id_fkey"
            columns: ["submission_review_id"]
            isOneToOne: false
            referencedRelation: "submission_reviews"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_file_lcomments_author_fkey"
            columns: ["author"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_file_lcomments_author_fkey"
            columns: ["author"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "submission_file_lcomments_submission_files_id_fkey"
            columns: ["submission_file_id"]
            isOneToOne: false
            referencedRelation: "submission_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_file_lcomments_submissions_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_file_lcomments_submissions_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_file_lcomments_submissions_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "submission_file_lcomments_submissions_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["activesubmissionid"]
          },
        ]
      }
      submission_files: {
        Row: {
          assignment_group_id: number | null
          class_id: number
          contents: string
          created_at: string
          id: number
          name: string
          profile_id: string | null
          submission_id: number
        }
        Insert: {
          assignment_group_id?: number | null
          class_id: number
          contents: string
          created_at?: string
          id?: number
          name: string
          profile_id?: string | null
          submission_id: number
        }
        Update: {
          assignment_group_id?: number | null
          class_id?: number
          contents?: string
          created_at?: string
          id?: number
          name?: string
          profile_id?: string | null
          submission_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "submission_files_assignment_group_id_fkey"
            columns: ["assignment_group_id"]
            isOneToOne: false
            referencedRelation: "assignment_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_files_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_files_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["student_profile_id"]
          },
          {
            foreignKeyName: "submission_files_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "submission_files_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "user_roles"
            referencedColumns: ["private_profile_id"]
          },
          {
            foreignKeyName: "submission_files_submissions_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_files_submissions_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_files_submissions_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "submission_files_submissions_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "submission_files_user_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_files_user_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      submission_ordinal_counters: {
        Row: {
          assignment_group_id: number
          assignment_id: number
          next_ordinal: number
          profile_id: string
          updated_at: string
        }
        Insert: {
          assignment_group_id?: number
          assignment_id: number
          next_ordinal?: number
          profile_id?: string
          updated_at?: string
        }
        Update: {
          assignment_group_id?: number
          assignment_id?: number
          next_ordinal?: number
          profile_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "submission_ordinal_counters_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_ordinal_counters_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_ordinal_counters_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_ordinal_counters_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_ordinal_counters_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
        ]
      }
      submission_regrade_request_comments: {
        Row: {
          assignment_id: number
          author: string
          class_id: number
          comment: string
          created_at: string
          id: number
          submission_id: number
          submission_regrade_request_id: number
          updated_at: string
        }
        Insert: {
          assignment_id: number
          author: string
          class_id: number
          comment: string
          created_at?: string
          id?: number
          submission_id: number
          submission_regrade_request_id: number
          updated_at?: string
        }
        Update: {
          assignment_id?: number
          author?: string
          class_id?: number
          comment?: string
          created_at?: string
          id?: number
          submission_id?: number
          submission_regrade_request_id?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "submission_regrade_request_comments_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_request_comments_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_request_comments_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_request_comments_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_request_comments_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "submission_regrade_request_comments_author_fkey"
            columns: ["author"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_request_comments_author_fkey"
            columns: ["author"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "submission_regrade_request_comments_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_request_comments_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_request_comments_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_request_comments_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "submission_regrade_request_comments_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "submission_regrade_request_comments_submission_regrade_request_"
            columns: ["submission_regrade_request_id"]
            isOneToOne: false
            referencedRelation: "submission_regrade_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      submission_regrade_requests: {
        Row: {
          assignee: string
          assignment_id: number
          class_id: number
          closed_at: string | null
          closed_by: string | null
          closed_points: number | null
          created_at: string
          created_by: string
          escalated_at: string | null
          escalated_by: string | null
          id: number
          initial_points: number | null
          last_commented_at: string | null
          last_commented_by: string | null
          last_updated_at: string
          opened_at: string | null
          resolved_at: string | null
          resolved_by: string | null
          resolved_points: number | null
          status: Database["public"]["Enums"]["regrade_status"]
          submission_artifact_comment_id: number | null
          submission_comment_id: number | null
          submission_file_comment_id: number | null
          submission_id: number
          updated_at: string
        }
        Insert: {
          assignee: string
          assignment_id: number
          class_id: number
          closed_at?: string | null
          closed_by?: string | null
          closed_points?: number | null
          created_at?: string
          created_by: string
          escalated_at?: string | null
          escalated_by?: string | null
          id?: number
          initial_points?: number | null
          last_commented_at?: string | null
          last_commented_by?: string | null
          last_updated_at?: string
          opened_at?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_points?: number | null
          status: Database["public"]["Enums"]["regrade_status"]
          submission_artifact_comment_id?: number | null
          submission_comment_id?: number | null
          submission_file_comment_id?: number | null
          submission_id: number
          updated_at?: string
        }
        Update: {
          assignee?: string
          assignment_id?: number
          class_id?: number
          closed_at?: string | null
          closed_by?: string | null
          closed_points?: number | null
          created_at?: string
          created_by?: string
          escalated_at?: string | null
          escalated_by?: string | null
          id?: number
          initial_points?: number | null
          last_commented_at?: string | null
          last_commented_by?: string | null
          last_updated_at?: string
          opened_at?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_points?: number | null
          status?: Database["public"]["Enums"]["regrade_status"]
          submission_artifact_comment_id?: number | null
          submission_comment_id?: number | null
          submission_file_comment_id?: number | null
          submission_id?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "submission_regrade_requests_assignee_fkey"
            columns: ["assignee"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_requests_assignee_fkey"
            columns: ["assignee"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "submission_regrade_requests_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_requests_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_requests_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_requests_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_requests_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "submission_regrade_requests_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_requests_closed_by_fkey"
            columns: ["closed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_requests_closed_by_fkey"
            columns: ["closed_by"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "submission_regrade_requests_last_commented_by_fkey"
            columns: ["last_commented_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_requests_last_commented_by_fkey"
            columns: ["last_commented_by"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "submission_regrade_requests_submission_artifact_comment_id_fkey"
            columns: ["submission_artifact_comment_id"]
            isOneToOne: false
            referencedRelation: "submission_artifact_comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_requests_submission_comment_id_fkey"
            columns: ["submission_comment_id"]
            isOneToOne: false
            referencedRelation: "submission_comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_requests_submission_file_comment_id_fkey"
            columns: ["submission_file_comment_id"]
            isOneToOne: false
            referencedRelation: "submission_file_comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_requests_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_requests_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_requests_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "submission_regrade_requests_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "submission_regrade_requests_submitted_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_regrade_requests_submitted_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      submission_reviews: {
        Row: {
          checked_at: string | null
          checked_by: string | null
          class_id: number
          completed_at: string | null
          completed_by: string | null
          created_at: string
          grader: string | null
          id: number
          meta_grader: string | null
          name: string
          released: boolean
          rubric_id: number
          submission_id: number
          total_autograde_score: number
          total_score: number
          tweak: number
          updated_at: string
        }
        Insert: {
          checked_at?: string | null
          checked_by?: string | null
          class_id: number
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          grader?: string | null
          id?: number
          meta_grader?: string | null
          name: string
          released?: boolean
          rubric_id: number
          submission_id: number
          total_autograde_score?: number
          total_score: number
          tweak: number
          updated_at?: string
        }
        Update: {
          checked_at?: string | null
          checked_by?: string | null
          class_id?: number
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          grader?: string | null
          id?: number
          meta_grader?: string | null
          name?: string
          released?: boolean
          rubric_id?: number
          submission_id?: number
          total_autograde_score?: number
          total_score?: number
          tweak?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "submission_reviews_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_reviews_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_reviews_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "submission_reviews_grader_fkey"
            columns: ["grader"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_reviews_grader_fkey"
            columns: ["grader"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "submission_reviews_meta_grader_fkey"
            columns: ["meta_grader"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_reviews_meta_grader_fkey"
            columns: ["meta_grader"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "submission_reviews_rubric_id_fkey"
            columns: ["rubric_id"]
            isOneToOne: false
            referencedRelation: "rubrics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_reviews_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_reviews_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_reviews_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "submission_reviews_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["activesubmissionid"]
          },
        ]
      }
      submissions: {
        Row: {
          assignment_group_id: number | null
          assignment_id: number
          class_id: number
          created_at: string
          grading_review_id: number | null
          id: number
          is_active: boolean
          is_not_graded: boolean
          ordinal: number
          profile_id: string | null
          released: string | null
          repository: string
          repository_check_run_id: number | null
          repository_id: number | null
          run_attempt: number
          run_number: number
          sha: string
        }
        Insert: {
          assignment_group_id?: number | null
          assignment_id: number
          class_id: number
          created_at?: string
          grading_review_id?: number | null
          id?: number
          is_active?: boolean
          is_not_graded?: boolean
          ordinal?: number
          profile_id?: string | null
          released?: string | null
          repository: string
          repository_check_run_id?: number | null
          repository_id?: number | null
          run_attempt: number
          run_number: number
          sha: string
        }
        Update: {
          assignment_group_id?: number | null
          assignment_id?: number
          class_id?: number
          created_at?: string
          grading_review_id?: number | null
          id?: number
          is_active?: boolean
          is_not_graded?: boolean
          ordinal?: number
          profile_id?: string | null
          released?: string | null
          repository?: string
          repository_check_run_id?: number | null
          repository_id?: number | null
          run_attempt?: number
          run_number?: number
          sha?: string
        }
        Relationships: [
          {
            foreignKeyName: "submissio_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissio_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissio_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissio_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissio_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "submissio_user_id_fkey1"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissio_user_id_fkey1"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "submissions_assignment_group_id_fkey"
            columns: ["assignment_group_id"]
            isOneToOne: false
            referencedRelation: "assignment_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_grading_review_id_fkey"
            columns: ["grading_review_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["submission_review_id"]
          },
          {
            foreignKeyName: "submissions_grading_review_id_fkey"
            columns: ["grading_review_id"]
            isOneToOne: false
            referencedRelation: "submission_reviews"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["student_profile_id"]
          },
          {
            foreignKeyName: "submissions_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "submissions_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "user_roles"
            referencedColumns: ["private_profile_id"]
          },
          {
            foreignKeyName: "submissions_repository_check_run_id_fkey"
            columns: ["repository_check_run_id"]
            isOneToOne: false
            referencedRelation: "repository_check_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_repository_id_fkey"
            columns: ["repository_id"]
            isOneToOne: false
            referencedRelation: "repositories"
            referencedColumns: ["id"]
          },
        ]
      }
      survey_assignments: {
        Row: {
          class_id: number
          created_at: string
          id: string
          profile_id: string
          survey_id: string
        }
        Insert: {
          class_id: number
          created_at?: string
          id?: string
          profile_id: string
          survey_id: string
        }
        Update: {
          class_id?: number
          created_at?: string
          id?: string
          profile_id?: string
          survey_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "survey_assignments_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "survey_assignments_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "survey_assignments_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "survey_assignments_survey_id_fkey"
            columns: ["survey_id"]
            isOneToOne: false
            referencedRelation: "surveys"
            referencedColumns: ["id"]
          },
        ]
      }
      survey_responses: {
        Row: {
          created_at: string
          deleted_at: string | null
          id: string
          is_submitted: boolean
          profile_id: string
          response: Json
          submitted_at: string | null
          survey_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_submitted?: boolean
          profile_id: string
          response?: Json
          submitted_at?: string | null
          survey_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_submitted?: boolean
          profile_id?: string
          response?: Json
          submitted_at?: string | null
          survey_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "survey_responses_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "survey_responses_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "survey_responses_survey_id_fkey"
            columns: ["survey_id"]
            isOneToOne: false
            referencedRelation: "surveys"
            referencedColumns: ["id"]
          },
        ]
      }
      survey_templates: {
        Row: {
          class_id: number
          created_at: string
          created_by: string
          description: string
          id: string
          scope: Database["public"]["Enums"]["template_scope"]
          template: Json
          title: string
          updated_at: string
          version: number
        }
        Insert: {
          class_id: number
          created_at?: string
          created_by: string
          description?: string
          id?: string
          scope?: Database["public"]["Enums"]["template_scope"]
          template?: Json
          title: string
          updated_at?: string
          version?: number
        }
        Update: {
          class_id?: number
          created_at?: string
          created_by?: string
          description?: string
          id?: string
          scope?: Database["public"]["Enums"]["template_scope"]
          template?: Json
          title?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "survey_templates_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "survey_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "survey_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      surveys: {
        Row: {
          allow_response_editing: boolean
          assigned_to_all: boolean
          class_id: number
          created_at: string
          created_by: string
          deleted_at: string | null
          description: string | null
          due_date: string | null
          id: string
          json: Json
          status: Database["public"]["Enums"]["survey_status"]
          survey_id: string
          title: string
          type: Database["public"]["Enums"]["survey_type"]
          updated_at: string
          validation_errors: string | null
          version: number
        }
        Insert: {
          allow_response_editing?: boolean
          assigned_to_all?: boolean
          class_id: number
          created_at?: string
          created_by: string
          deleted_at?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          json?: Json
          status?: Database["public"]["Enums"]["survey_status"]
          survey_id?: string
          title: string
          type?: Database["public"]["Enums"]["survey_type"]
          updated_at?: string
          validation_errors?: string | null
          version?: number
        }
        Update: {
          allow_response_editing?: boolean
          assigned_to_all?: boolean
          class_id?: number
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          json?: Json
          status?: Database["public"]["Enums"]["survey_status"]
          survey_id?: string
          title?: string
          type?: Database["public"]["Enums"]["survey_type"]
          updated_at?: string
          validation_errors?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "surveys_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "surveys_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "surveys_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      system_settings: {
        Row: {
          created_at: string
          created_by: string | null
          key: string
          updated_at: string
          updated_by: string | null
          value: Json
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          key: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Update: {
          created_at?: string
          created_by?: string | null
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "system_settings_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "system_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      tags: {
        Row: {
          class_id: number
          color: string
          created_at: string
          creator_id: string
          id: string
          name: string
          profile_id: string
          updated_at: string
          visible: boolean
        }
        Insert: {
          class_id: number
          color: string
          created_at?: string
          creator_id?: string
          id?: string
          name: string
          profile_id: string
          updated_at?: string
          visible: boolean
        }
        Update: {
          class_id?: number
          color?: string
          created_at?: string
          creator_id?: string
          id?: string
          name?: string
          profile_id?: string
          updated_at?: string
          visible?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "tags_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tags_creator_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "tags_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tags_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      user_privileges: {
        Row: {
          class_id: number
          private_profile_id: string | null
          public_profile_id: string | null
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          class_id: number
          private_profile_id?: string | null
          public_profile_id?: string | null
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          class_id?: number
          private_profile_id?: string | null
          public_profile_id?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          canvas_id: number | null
          class_id: number
          class_section_id: number | null
          disabled: boolean
          github_org_confirmed: boolean | null
          id: number
          invitation_date: string | null
          invitation_id: number | null
          lab_section_id: number | null
          private_profile_id: string
          public_profile_id: string
          role: Database["public"]["Enums"]["app_role"]
          sis_sync_opt_out: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          canvas_id?: number | null
          class_id: number
          class_section_id?: number | null
          disabled?: boolean
          github_org_confirmed?: boolean | null
          id?: number
          invitation_date?: string | null
          invitation_id?: number | null
          lab_section_id?: number | null
          private_profile_id: string
          public_profile_id: string
          role: Database["public"]["Enums"]["app_role"]
          sis_sync_opt_out?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          canvas_id?: number | null
          class_id?: number
          class_section_id?: number | null
          disabled?: boolean
          github_org_confirmed?: boolean | null
          id?: number
          invitation_date?: string | null
          invitation_id?: number | null
          lab_section_id?: number | null
          private_profile_id?: string
          public_profile_id?: string
          role?: Database["public"]["Enums"]["app_role"]
          sis_sync_opt_out?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_user_roles_invitation_id"
            columns: ["invitation_id"]
            isOneToOne: false
            referencedRelation: "invitations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_roles_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_roles_class_section_id_fkey"
            columns: ["class_section_id"]
            isOneToOne: false
            referencedRelation: "class_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_roles_lab_section_id_fkey"
            columns: ["lab_section_id"]
            isOneToOne: false
            referencedRelation: "lab_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_roles_private_profile_id_fkey"
            columns: ["private_profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_roles_private_profile_id_fkey"
            columns: ["private_profile_id"]
            isOneToOne: true
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "user_roles_public_profile_id_fkey"
            columns: ["public_profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_roles_public_profile_id_fkey"
            columns: ["public_profile_id"]
            isOneToOne: true
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "user_roles_user_id_fkey1"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      users: {
        Row: {
          avatar_url: string | null
          created_at: string
          discord_id: string | null
          discord_username: string | null
          email: string | null
          github_user_id: string | null
          github_username: string | null
          last_github_user_sync: string | null
          name: string | null
          sis_user_id: number | null
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          discord_id?: string | null
          discord_username?: string | null
          email?: string | null
          github_user_id?: string | null
          github_username?: string | null
          last_github_user_sync?: string | null
          name?: string | null
          sis_user_id?: number | null
          user_id?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          discord_id?: string | null
          discord_username?: string | null
          email?: string | null
          github_user_id?: string | null
          github_username?: string | null
          last_github_user_sync?: string | null
          name?: string | null
          sis_user_id?: number | null
          user_id?: string
        }
        Relationships: []
      }
      video_meeting_session_users: {
        Row: {
          chime_attendee_id: string | null
          class_id: number
          created_at: string
          id: number
          joined_at: string
          left_at: string | null
          private_profile_id: string
          video_meeting_session_id: number
        }
        Insert: {
          chime_attendee_id?: string | null
          class_id: number
          created_at?: string
          id?: number
          joined_at?: string
          left_at?: string | null
          private_profile_id: string
          video_meeting_session_id: number
        }
        Update: {
          chime_attendee_id?: string | null
          class_id?: number
          created_at?: string
          id?: number
          joined_at?: string
          left_at?: string | null
          private_profile_id?: string
          video_meeting_session_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "video_meeting_session_users_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_meeting_session_users_private_profile_id_fkey"
            columns: ["private_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_meeting_session_users_private_profile_id_fkey"
            columns: ["private_profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "video_meeting_session_users_video_meeting_session_id_fkey"
            columns: ["video_meeting_session_id"]
            isOneToOne: false
            referencedRelation: "video_meeting_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      video_meeting_sessions: {
        Row: {
          chime_meeting_id: string | null
          class_id: number
          created_at: string
          ended: string | null
          help_request_id: number
          id: number
          started: string | null
        }
        Insert: {
          chime_meeting_id?: string | null
          class_id: number
          created_at?: string
          ended?: string | null
          help_request_id: number
          id?: number
          started?: string | null
        }
        Update: {
          chime_meeting_id?: string | null
          class_id?: number
          created_at?: string
          ended?: string | null
          help_request_id?: number
          id?: number
          started?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "video_meeting_sessions_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_meeting_sessions_help_request_id_fkey"
            columns: ["help_request_id"]
            isOneToOne: false
            referencedRelation: "help_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_events: {
        Row: {
          actor_login: string | null
          class_id: number | null
          conclusion: string | null
          created_at: string | null
          event_type: string
          github_repository_id: number | null
          head_branch: string | null
          head_sha: string | null
          id: number
          payload: Json | null
          pull_requests: Json | null
          repository_id: number | null
          repository_name: string
          run_attempt: number | null
          run_number: number | null
          run_started_at: string | null
          run_updated_at: string | null
          started_at: string | null
          status: string | null
          triggering_actor_login: string | null
          updated_at: string | null
          workflow_name: string | null
          workflow_path: string | null
          workflow_run_id: number
        }
        Insert: {
          actor_login?: string | null
          class_id?: number | null
          conclusion?: string | null
          created_at?: string | null
          event_type: string
          github_repository_id?: number | null
          head_branch?: string | null
          head_sha?: string | null
          id?: number
          payload?: Json | null
          pull_requests?: Json | null
          repository_id?: number | null
          repository_name: string
          run_attempt?: number | null
          run_number?: number | null
          run_started_at?: string | null
          run_updated_at?: string | null
          started_at?: string | null
          status?: string | null
          triggering_actor_login?: string | null
          updated_at?: string | null
          workflow_name?: string | null
          workflow_path?: string | null
          workflow_run_id: number
        }
        Update: {
          actor_login?: string | null
          class_id?: number | null
          conclusion?: string | null
          created_at?: string | null
          event_type?: string
          github_repository_id?: number | null
          head_branch?: string | null
          head_sha?: string | null
          id?: number
          payload?: Json | null
          pull_requests?: Json | null
          repository_id?: number | null
          repository_name?: string
          run_attempt?: number | null
          run_number?: number | null
          run_started_at?: string | null
          run_updated_at?: string | null
          started_at?: string | null
          status?: string | null
          triggering_actor_login?: string | null
          updated_at?: string | null
          workflow_name?: string | null
          workflow_path?: string | null
          workflow_run_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "workflow_events_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_events_repository_id_fkey"
            columns: ["repository_id"]
            isOneToOne: false
            referencedRelation: "repositories"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_run_error: {
        Row: {
          autograder_regression_test_id: number | null
          class_id: number
          created_at: string
          data: Json | null
          id: string
          is_private: boolean
          name: string
          repository_id: number
          run_attempt: number | null
          run_number: number | null
          submission_id: number | null
        }
        Insert: {
          autograder_regression_test_id?: number | null
          class_id: number
          created_at?: string
          data?: Json | null
          id?: string
          is_private?: boolean
          name: string
          repository_id: number
          run_attempt?: number | null
          run_number?: number | null
          submission_id?: number | null
        }
        Update: {
          autograder_regression_test_id?: number | null
          class_id?: number
          created_at?: string
          data?: Json | null
          id?: string
          is_private?: boolean
          name?: string
          repository_id?: number
          run_attempt?: number | null
          run_number?: number | null
          submission_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "workflow_run_error_autograder_regression_test_id_fkey"
            columns: ["autograder_regression_test_id"]
            isOneToOne: false
            referencedRelation: "autograder_regression_test"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_run_error_autograder_regression_test_id_fkey"
            columns: ["autograder_regression_test_id"]
            isOneToOne: false
            referencedRelation: "autograder_regression_test_by_grader"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_run_error_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_run_error_repository_id_fkey"
            columns: ["repository_id"]
            isOneToOne: false
            referencedRelation: "repositories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_run_error_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_run_error_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_run_error_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "workflow_run_error_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["activesubmissionid"]
          },
        ]
      }
      workflow_runs: {
        Row: {
          actor_login: string | null
          assignment_id: number | null
          class_id: number
          completed_at: string | null
          conclusion: string | null
          created_at: string
          head_branch: string | null
          head_sha: string | null
          id: number
          in_progress_at: string | null
          profile_id: string | null
          queue_time_seconds: number | null
          repository_name: string | null
          requested_at: string | null
          run_attempt: number
          run_number: number | null
          run_time_seconds: number | null
          triggering_actor_login: string | null
          updated_at: string
          workflow_name: string | null
          workflow_path: string | null
          workflow_run_id: number
        }
        Insert: {
          actor_login?: string | null
          assignment_id?: number | null
          class_id: number
          completed_at?: string | null
          conclusion?: string | null
          created_at?: string
          head_branch?: string | null
          head_sha?: string | null
          id?: number
          in_progress_at?: string | null
          profile_id?: string | null
          queue_time_seconds?: number | null
          repository_name?: string | null
          requested_at?: string | null
          run_attempt: number
          run_number?: number | null
          run_time_seconds?: number | null
          triggering_actor_login?: string | null
          updated_at?: string
          workflow_name?: string | null
          workflow_path?: string | null
          workflow_run_id: number
        }
        Update: {
          actor_login?: string | null
          assignment_id?: number | null
          class_id?: number
          completed_at?: string | null
          conclusion?: string | null
          created_at?: string
          head_branch?: string | null
          head_sha?: string | null
          id?: number
          in_progress_at?: string | null
          profile_id?: string | null
          queue_time_seconds?: number | null
          repository_name?: string | null
          requested_at?: string | null
          run_attempt?: number
          run_number?: number | null
          run_time_seconds?: number | null
          triggering_actor_login?: string | null
          updated_at?: string
          workflow_name?: string | null
          workflow_path?: string | null
          workflow_run_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "workflow_runs_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_runs_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_runs_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_runs_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_runs_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "workflow_runs_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_runs_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_runs_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
    }
    Views: {
      active_submissions_for_class: {
        Row: {
          assignment_id: number | null
          class_id: number | null
          groupname: string | null
          student_private_profile_id: string | null
          submission_id: number | null
        }
        Relationships: []
      }
      assignment_overview: {
        Row: {
          active_submissions_count: number | null
          class_id: number | null
          due_date: string | null
          id: number | null
          open_regrade_requests_count: number | null
          release_date: string | null
          title: string | null
        }
        Insert: {
          active_submissions_count?: never
          class_id?: number | null
          due_date?: string | null
          id?: number | null
          open_regrade_requests_count?: never
          release_date?: string | null
          title?: string | null
        }
        Update: {
          active_submissions_count?: never
          class_id?: number | null
          due_date?: string | null
          id?: number | null
          open_regrade_requests_count?: never
          release_date?: string | null
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "assignments_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      assignments_for_student_dashboard: {
        Row: {
          allow_not_graded_submissions: boolean | null
          allow_student_formed_groups: boolean | null
          archived_at: string | null
          assignment_self_review_setting_id: number | null
          autograder_points: number | null
          class_id: number | null
          created_at: string | null
          description: string | null
          due_date: string | null
          due_date_exception_id: number | null
          exception_created_at: string | null
          exception_creator_id: string | null
          exception_hours: number | null
          exception_minutes: number | null
          exception_note: string | null
          exception_tokens_consumed: number | null
          gradebook_column_id: number | null
          grader_result_id: number | null
          grader_result_max_score: number | null
          grader_result_score: number | null
          grading_rubric_id: number | null
          group_config:
            | Database["public"]["Enums"]["assignment_group_mode"]
            | null
          group_formation_deadline: string | null
          has_autograder: boolean | null
          has_handgrader: boolean | null
          id: number | null
          is_github_ready: boolean | null
          latest_template_sha: string | null
          max_group_size: number | null
          max_late_tokens: number | null
          meta_grading_rubric_id: number | null
          min_group_size: number | null
          minutes_due_after_lab: number | null
          release_date: string | null
          repository: string | null
          repository_id: number | null
          review_assignment_id: number | null
          review_submission_id: number | null
          self_review_deadline_offset: number | null
          self_review_enabled: boolean | null
          self_review_rubric_id: number | null
          self_review_setting_id: number | null
          slug: string | null
          student_profile_id: string | null
          student_repo_prefix: string | null
          student_user_id: string | null
          submission_created_at: string | null
          submission_id: number | null
          submission_is_active: boolean | null
          submission_ordinal: number | null
          submission_review_completed_at: string | null
          submission_review_id: number | null
          template_repo: string | null
          title: string | null
          total_points: number | null
        }
        Relationships: [
          {
            foreignKeyName: "assignment_late_exception_instructor_id_fkey"
            columns: ["exception_creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_late_exception_instructor_id_fkey"
            columns: ["exception_creator_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "assignments_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_meta_grading_rubric_id_fkey"
            columns: ["meta_grading_rubric_id"]
            isOneToOne: false
            referencedRelation: "rubrics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_rubric_id_fkey"
            columns: ["grading_rubric_id"]
            isOneToOne: false
            referencedRelation: "rubrics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_self_review_rubric_id_fkey"
            columns: ["self_review_rubric_id"]
            isOneToOne: false
            referencedRelation: "rubrics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_self_review_setting_fkey"
            columns: ["self_review_setting_id"]
            isOneToOne: false
            referencedRelation: "assignment_self_review_settings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_self_review_setting_fkey"
            columns: ["self_review_setting_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["assignment_self_review_setting_id"]
          },
          {
            foreignKeyName: "review_assignments_submission_id_fkey"
            columns: ["review_submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_assignments_submission_id_fkey"
            columns: ["review_submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_assignments_submission_id_fkey"
            columns: ["review_submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["activesubmissionid"]
          },
          {
            foreignKeyName: "review_assignments_submission_id_fkey"
            columns: ["review_submission_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["activesubmissionid"]
          },
        ]
      }
      assignments_with_effective_due_dates: {
        Row: {
          allow_student_formed_groups: boolean | null
          archived_at: string | null
          autograder_points: number | null
          class_id: number | null
          created_at: string | null
          description: string | null
          due_date: string | null
          gradebook_column_id: number | null
          grading_rubric_id: number | null
          group_config:
            | Database["public"]["Enums"]["assignment_group_mode"]
            | null
          group_formation_deadline: string | null
          has_autograder: boolean | null
          has_handgrader: boolean | null
          id: number | null
          latest_template_sha: string | null
          max_group_size: number | null
          max_late_tokens: number | null
          meta_grading_rubric_id: number | null
          min_group_size: number | null
          minutes_due_after_lab: number | null
          release_date: string | null
          self_review_rubric_id: number | null
          self_review_setting_id: number | null
          slug: string | null
          student_profile_id: string | null
          student_repo_prefix: string | null
          template_repo: string | null
          title: string | null
          total_points: number | null
        }
        Relationships: [
          {
            foreignKeyName: "assignments_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_meta_grading_rubric_id_fkey"
            columns: ["meta_grading_rubric_id"]
            isOneToOne: false
            referencedRelation: "rubrics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_rubric_id_fkey"
            columns: ["grading_rubric_id"]
            isOneToOne: false
            referencedRelation: "rubrics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_self_review_rubric_id_fkey"
            columns: ["self_review_rubric_id"]
            isOneToOne: false
            referencedRelation: "rubrics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_self_review_setting_fkey"
            columns: ["self_review_setting_id"]
            isOneToOne: false
            referencedRelation: "assignment_self_review_settings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_self_review_setting_fkey"
            columns: ["self_review_setting_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["assignment_self_review_setting_id"]
          },
          {
            foreignKeyName: "user_roles_private_profile_id_fkey"
            columns: ["student_profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_roles_private_profile_id_fkey"
            columns: ["student_profile_id"]
            isOneToOne: true
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      autograder_regression_test_by_grader: {
        Row: {
          class_id: number | null
          grader_repo: string | null
          id: number | null
          name: string | null
          repository: string | null
          score: number | null
          sha: string | null
        }
        Relationships: [
          {
            foreignKeyName: "grader_results_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      flashcard_card_analytics: {
        Row: {
          answer_viewed_count: number | null
          avg_answer_time_ms: number | null
          avg_got_it_time_ms: number | null
          avg_keep_trying_time_ms: number | null
          card_id: number | null
          class_id: number | null
          deck_id: number | null
          got_it_count: number | null
          keep_trying_count: number | null
          prompt_views: number | null
          returned_to_deck: number | null
        }
        Relationships: [
          {
            foreignKeyName: "flashcard_interaction_logs_card_id_fkey"
            columns: ["card_id"]
            isOneToOne: false
            referencedRelation: "flashcards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flashcard_interaction_logs_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flashcard_interaction_logs_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: false
            referencedRelation: "flashcard_deck_analytics"
            referencedColumns: ["deck_id"]
          },
          {
            foreignKeyName: "flashcard_interaction_logs_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: false
            referencedRelation: "flashcard_decks"
            referencedColumns: ["id"]
          },
        ]
      }
      flashcard_deck_analytics: {
        Row: {
          class_id: number | null
          deck_id: number | null
          deck_name: string | null
          resets: number | null
          views: number | null
        }
        Relationships: [
          {
            foreignKeyName: "flashcard_decks_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      flashcard_student_card_analytics: {
        Row: {
          answer_views: number | null
          avg_answer_time_ms: number | null
          avg_got_it_time_ms: number | null
          avg_keep_trying_time_ms: number | null
          card_id: number | null
          class_id: number | null
          deck_id: number | null
          got_it_count: number | null
          keep_trying_count: number | null
          prompt_views: number | null
          returned_to_deck: number | null
          student_name: string | null
          student_profile_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "flashcard_interaction_logs_card_id_fkey"
            columns: ["card_id"]
            isOneToOne: false
            referencedRelation: "flashcards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flashcard_interaction_logs_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flashcard_interaction_logs_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: false
            referencedRelation: "flashcard_deck_analytics"
            referencedColumns: ["deck_id"]
          },
          {
            foreignKeyName: "flashcard_interaction_logs_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: false
            referencedRelation: "flashcard_decks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flashcard_interaction_logs_student_id_fkey"
            columns: ["student_profile_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      flashcard_student_deck_analytics: {
        Row: {
          answer_views: number | null
          class_id: number | null
          deck_id: number | null
          mastered_count: number | null
          name: string | null
          not_mastered_count: number | null
          prompt_views: number | null
          returned_to_deck: number | null
          student_profile_id: string | null
        }
        Relationships: []
      }
      review_assignments_summary_by_assignee: {
        Row: {
          assignee_profile_id: string | null
          assignment_id: number | null
          assignment_title: string | null
          class_id: number | null
          completed_reviews: number | null
          earliest_release_date: string | null
          incomplete_reviews: number | null
          soonest_due_date: string | null
          total_reviews: number | null
        }
        Relationships: [
          {
            foreignKeyName: "review_assignments_assignee_profile_id_fkey"
            columns: ["assignee_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_assignments_assignee_profile_id_fkey"
            columns: ["assignee_profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "review_assignments_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_assignments_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_assignments_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_assignments_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_assignments_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "review_assignments_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      submissions_agg: {
        Row: {
          assignment_id: number | null
          avatar_url: string | null
          created_at: string | null
          execution_time: number | null
          groupname: string | null
          id: number | null
          latestsubmissionid: number | null
          name: string | null
          profile_id: string | null
          released: string | null
          repository: string | null
          ret_code: number | null
          run_attempt: number | null
          run_number: number | null
          score: number | null
          sha: string | null
          sortable_name: string | null
          submissioncount: number | null
          user_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "submissio_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissio_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissio_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissio_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissio_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "submissio_user_id_fkey1"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissio_user_id_fkey1"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "submissions_profile_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["student_profile_id"]
          },
          {
            foreignKeyName: "submissions_profile_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "submissions_profile_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_roles"
            referencedColumns: ["private_profile_id"]
          },
          {
            foreignKeyName: "user_roles_private_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_roles_private_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      submissions_with_grades_for_assignment_and_regression_test: {
        Row: {
          activesubmissionid: number | null
          assignment_id: number | null
          autograder_score: number | null
          class_id: number | null
          class_section_id: number | null
          class_section_name: string | null
          created_at: string | null
          effective_due_date: string | null
          grader_action_sha: string | null
          grader_sha: string | null
          groupname: string | null
          id: number | null
          lab_section_id: number | null
          lab_section_name: string | null
          late_due_date: string | null
          name: string | null
          released: string | null
          repository: string | null
          rerun_queued_at: string | null
          rt_autograder_score: number | null
          rt_grader_action_sha: string | null
          rt_grader_sha: string | null
          sha: string | null
          sortable_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_roles_class_section_id_fkey"
            columns: ["class_section_id"]
            isOneToOne: false
            referencedRelation: "class_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_roles_lab_section_id_fkey"
            columns: ["lab_section_id"]
            isOneToOne: false
            referencedRelation: "lab_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      submissions_with_grades_for_assignment_nice: {
        Row: {
          activesubmissionid: number | null
          assignedgradername: string | null
          assignedmetagradername: string | null
          assignment_id: number | null
          assignment_slug: string | null
          autograder_score: number | null
          checked_at: string | null
          checked_by: string | null
          checkername: string | null
          class_id: number | null
          class_section_id: number | null
          class_section_name: string | null
          completed_at: string | null
          completed_by: string | null
          created_at: string | null
          due_date: string | null
          grader: string | null
          grader_action_sha: string | null
          grader_sha: string | null
          gradername: string | null
          groupname: string | null
          hours: number | null
          id: number | null
          lab_section_id: number | null
          lab_section_name: string | null
          late_due_date: string | null
          meta_grader: string | null
          name: string | null
          released: string | null
          repository: string | null
          sha: string | null
          sortable_name: string | null
          student_private_profile_id: string | null
          tokens_consumed: number | null
          total_score: number | null
          tweak: number | null
        }
        Relationships: [
          {
            foreignKeyName: "submission_reviews_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_reviews_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "submission_reviews_grader_fkey"
            columns: ["grader"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_reviews_grader_fkey"
            columns: ["grader"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "submission_reviews_meta_grader_fkey"
            columns: ["meta_grader"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_reviews_meta_grader_fkey"
            columns: ["meta_grader"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
        ]
      }
      submissions_with_reviews_by_round_for_assignment: {
        Row: {
          assignment_id: number | null
          assignment_slug: string | null
          class_id: number | null
          scores_by_round_private: Json | null
          scores_by_round_public: Json | null
          student_private_profile_id: string | null
        }
        Relationships: []
      }
      workflow_timing_summary: {
        Row: {
          assignment_id: number | null
          class_id: number | null
          completed_at: string | null
          in_progress_at: string | null
          profile_id: string | null
          queue_time_seconds: number | null
          requested_at: string | null
          run_attempt: number | null
          run_time_seconds: number | null
          workflow_run_id: number | null
        }
        Relationships: [
          {
            foreignKeyName: "repositories_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignment_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repositories_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repositories_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_for_student_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repositories_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repositories_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "repositories_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "assignments_with_effective_due_dates"
            referencedColumns: ["student_profile_id"]
          },
          {
            foreignKeyName: "repositories_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "repositories_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "user_roles"
            referencedColumns: ["private_profile_id"]
          },
          {
            foreignKeyName: "repositories_user_id_fkey1"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repositories_user_id_fkey1"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "submissions_with_grades_for_assignment_nice"
            referencedColumns: ["student_private_profile_id"]
          },
          {
            foreignKeyName: "workflow_events_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      _help_request_public_payload: {
        Args: {
          new_row: Database["public"]["Tables"]["help_requests"]["Row"]
          old_row: Database["public"]["Tables"]["help_requests"]["Row"]
          tg_op: string
        }
        Returns: Json
      }
      admin_bulk_set_user_roles_disabled: {
        Args: {
          p_admin_user_id?: string
          p_disabled: boolean
          p_user_role_ids: number[]
        }
        Returns: number
      }
      admin_create_class: {
        Args: {
          p_course_title?: string
          p_created_by?: string
          p_description?: string
          p_end_date?: string
          p_github_org_name?: string
          p_github_template_prefix?: string
          p_name: string
          p_start_date?: string
          p_term: number
        }
        Returns: number
      }
      admin_create_class_section: {
        Args: {
          p_campus?: string
          p_class_id: number
          p_created_by?: string
          p_meeting_location?: string
          p_meeting_times?: string
          p_name: string
          p_sis_crn?: number
        }
        Returns: number
      }
      admin_create_lab_section: {
        Args: {
          p_campus?: string
          p_class_id: number
          p_created_by?: string
          p_day_of_week?: Database["public"]["Enums"]["day_of_week"]
          p_description?: string
          p_end_time?: string
          p_meeting_location?: string
          p_meeting_times?: string
          p_name: string
          p_sis_crn?: number
          p_start_time?: string
        }
        Returns: number
      }
      admin_delete_class: {
        Args: { p_class_id: number; p_deleted_by?: string }
        Returns: boolean
      }
      admin_delete_class_section: {
        Args: { p_deleted_by?: string; p_section_id: number }
        Returns: boolean
      }
      admin_delete_lab_section: {
        Args: { p_deleted_by?: string; p_section_id: number }
        Returns: boolean
      }
      admin_get_class_sections: {
        Args: { p_class_id: number }
        Returns: {
          campus: string
          created_at: string
          meeting_location: string
          meeting_times: string
          member_count: number
          section_id: number
          section_name: string
          section_type: string
          sis_crn: number
          updated_at: string
        }[]
      }
      admin_get_classes: {
        Args: never
        Returns: {
          archived: boolean
          created_at: string
          description: string
          github_org_name: string
          github_template_prefix: string
          id: number
          instructor_count: number
          name: string
          student_count: number
          term: number
        }[]
      }
      admin_get_disabled_users: {
        Args: { p_class_id?: number }
        Returns: {
          class_id: number
          class_name: string
          disabled_at: string
          profile_name: string
          role: Database["public"]["Enums"]["app_role"]
          user_email: string
          user_id: string
          user_name: string
          user_role_id: number
        }[]
      }
      admin_get_sis_sync_status: {
        Args: never
        Returns: {
          class_id: number
          class_name: string
          expired_invitations: number
          last_sync_message: string
          last_sync_status: string
          last_sync_time: string
          pending_invitations: number
          sis_sections_count: number
          sync_enabled: boolean
          term: number
          total_invitations: number
        }[]
      }
      admin_set_section_sync_enabled: {
        Args: {
          p_admin_user_id?: string
          p_course_id: number
          p_course_section_id?: number
          p_enabled: boolean
          p_lab_section_id?: number
        }
        Returns: boolean
      }
      admin_set_sis_sync_enabled: {
        Args: {
          p_admin_user_id?: string
          p_class_id: number
          p_enabled: boolean
        }
        Returns: boolean
      }
      admin_set_user_role_disabled: {
        Args: {
          p_admin_user_id?: string
          p_disabled: boolean
          p_user_role_id: number
        }
        Returns: boolean
      }
      admin_trigger_sis_sync: { Args: { p_class_id?: number }; Returns: Json }
      admin_update_class: {
        Args: {
          p_class_id: number
          p_course_title?: string
          p_description?: string
          p_end_date?: string
          p_github_org_name?: string
          p_github_template_prefix?: string
          p_name?: string
          p_start_date?: string
          p_term?: number
          p_updated_by?: string
        }
        Returns: boolean
      }
      admin_update_class_section: {
        Args: { p_name: string; p_section_id: number; p_updated_by?: string }
        Returns: boolean
      }
      admin_update_lab_section: {
        Args: { p_name: string; p_section_id: number; p_updated_by?: string }
        Returns: boolean
      }
      authorize_for_admin: { Args: { p_user_id?: string }; Returns: boolean }
      authorize_for_private_discussion_thread: {
        Args: { p_root: number }
        Returns: boolean
      }
      authorize_for_submission: {
        Args: { requested_submission_id: number }
        Returns: boolean
      }
      authorize_for_submission_regrade_comment: {
        Args: { submission_regrade_request_id: number }
        Returns: boolean
      }
      authorize_for_submission_review: {
        Args: { submission_review_id: number }
        Returns: boolean
      }
      authorize_for_submission_review_writable: {
        Args: { submission_review_id: number }
        Returns: boolean
      }
      authorize_for_submission_reviewable: {
        Args: {
          requested_submission_id: number
          requested_submission_review_id: number
        }
        Returns: boolean
      }
      authorize_to_create_own_due_date_extension: {
        Args: {
          _assignment_group_id: number
          _assignment_id: number
          _class_id: number
          _creator_id: string
          _hours_to_extend: number
          _student_id: string
          _tokens_consumed: number
        }
        Returns: boolean
      }
      authorizeforanyclassstaff: { Args: never; Returns: boolean }
      authorizeforassignmentgroup: {
        Args: { _assignment_group_id: number }
        Returns: boolean
      }
      authorizeforclass: { Args: { class__id: number }; Returns: boolean }
      authorizeforclassgrader: { Args: { class__id: number }; Returns: boolean }
      authorizeforclassinstructor: {
        Args: { class__id: number }
        Returns: boolean
      }
      authorizeforinstructorofstudent: {
        Args: { _user_id: string }
        Returns: boolean
      }
      authorizeforinstructororgraderofstudent: {
        Args: { _user_id: string }
        Returns: boolean
      }
      authorizeforpoll:
        | { Args: { poll__id: number }; Returns: boolean }
        | { Args: { class__id: number; poll__id: number }; Returns: boolean }
      authorizeforprofile: { Args: { profile_id: string }; Returns: boolean }
      bulk_assign_reviews: {
        Args: {
          p_assignment_id: number
          p_class_id: number
          p_draft_assignments: Json
          p_due_date: string
          p_rubric_id: number
        }
        Returns: Json
      }
      calculate_effective_due_date: {
        Args: { assignment_id_param: number; student_profile_id_param: string }
        Returns: string
      }
      calculate_final_due_date: {
        Args: {
          assignment_group_id_param?: number
          assignment_id_param: number
          student_profile_id_param: string
        }
        Returns: string
      }
      calculate_queue_metrics_at_start: {
        Args: { p_help_request_id: number; p_queue_id: number }
        Returns: {
          longest_wait_seconds: number
          queue_depth: number
        }[]
      }
      call_edge_function_internal: {
        Args: {
          headers?: Json
          method: string
          new_record?: Json
          old_record?: Json
          op?: string
          params?: Json
          schema_name?: string
          table_name?: string
          timeout_ms?: number
          url_path: string
        }
        Returns: undefined
      }
      call_edge_function_internal_post_payload: {
        Args: {
          headers?: Json
          payload?: Json
          timeout_ms?: number
          url_path: string
        }
        Returns: undefined
      }
      can_access_help_request: {
        Args: { help_request_id: number }
        Returns: boolean
      }
      can_access_poll_response: {
        Args: { poll_id: string; profile_id: string }
        Returns: boolean
      }
      channel_has_subscribers: { Args: { p_channel: string }; Returns: boolean }
      check_assignment_deadlines_passed: { Args: never; Returns: undefined }
      check_assignment_release_dates: { Args: never; Returns: undefined }
      check_can_add_to_help_request: {
        Args: {
          p_class_id: number
          p_help_request_id: number
          p_user_id: string
        }
        Returns: boolean
      }
      check_can_remove_from_help_request: {
        Args: {
          p_class_id: number
          p_help_request_id: number
          p_profile_id_to_remove: string
          p_user_id: string
        }
        Returns: boolean
      }
      check_discord_role_sync_after_link: {
        Args: { p_user_id: string }
        Returns: undefined
      }
      check_github_error_threshold: {
        Args: { p_org: string; p_threshold: number; p_window_minutes: number }
        Returns: number
      }
      check_gradebook_realtime_authorization: {
        Args: { topic_text: string }
        Returns: boolean
      }
      check_unified_realtime_authorization: {
        Args: { topic_text: string }
        Returns: boolean
      }
      cleanup_expired_realtime_subscriptions: {
        Args: never
        Returns: undefined
      }
      cleanup_github_async_errors: { Args: never; Returns: undefined }
      clear_all_incomplete_review_assignments: {
        Args: { p_assignment_id: number; p_class_id: number }
        Returns: Json
      }
      clear_incomplete_assignments_for_user: {
        Args: {
          p_assignee_profile_id: string
          p_assignment_id: number
          p_class_id: number
          p_rubric_id?: number
          p_rubric_part_ids?: number[]
        }
        Returns: Json
      }
      clear_unfinished_review_assignments: {
        Args: {
          p_assignment_id: number
          p_class_id: number
          p_class_section_ids?: number[]
          p_lab_section_ids?: number[]
          p_rubric_id: number
          p_rubric_part_ids?: number[]
          p_student_tag_filters?: Json
        }
        Returns: Json
      }
      create_all_repos_for_assignment:
        | {
            Args: {
              assignment_id: number
              course_id: number
              p_force?: boolean
            }
            Returns: undefined
          }
        | {
            Args: {
              assignment_id: number
              course_id: number
              p_force?: boolean
            }
            Returns: undefined
          }
      create_help_request_message_notification: {
        Args: {
          p_author_name: string
          p_author_profile_id: string
          p_class_id: number
          p_help_queue_id: number
          p_help_queue_name: string
          p_help_request_creator_name: string
          p_help_request_creator_profile_id: string
          p_help_request_id: number
          p_is_private?: boolean
          p_message_id: number
          p_message_preview: string
        }
        Returns: undefined
      }
      create_help_request_notification: {
        Args: {
          p_action?: string
          p_assignee_name?: string
          p_assignee_profile_id?: string
          p_class_id: number
          p_creator_name: string
          p_creator_profile_id: string
          p_help_queue_id: number
          p_help_queue_name: string
          p_help_request_id: number
          p_is_private?: boolean
          p_notification_type: string
          p_request_preview?: string
          p_status?: Database["public"]["Enums"]["help_request_status"]
        }
        Returns: undefined
      }
      create_invitation: {
        Args: {
          p_class_id: number
          p_class_section_id?: number
          p_email?: string
          p_invited_by?: string
          p_lab_section_id?: number
          p_name?: string
          p_role: Database["public"]["Enums"]["app_role"]
          p_sis_managed?: boolean
          p_sis_user_id: number
        }
        Returns: number
      }
      create_regrade_request: {
        Args: {
          private_profile_id: string
          submission_artifact_comment_id?: number
          submission_comment_id?: number
          submission_file_comment_id?: number
        }
        Returns: number
      }
      create_repos_for_student: {
        Args: { class_id?: number; p_force?: boolean; user_id: string }
        Returns: undefined
      }
      create_survey_assignments: {
        Args: { p_profile_ids: string[]; p_survey_id: string }
        Returns: undefined
      }
      create_system_notification: {
        Args: {
          p_backdrop_dismiss?: boolean
          p_campaign_id?: string
          p_created_by?: string
          p_display?: string
          p_expires_at?: string
          p_icon?: string
          p_max_width?: string
          p_message: string
          p_persistent?: boolean
          p_position?: string
          p_severity?: string
          p_target_course_ids?: number[]
          p_target_roles?: Database["public"]["Enums"]["app_role"][]
          p_target_user_ids?: string[]
          p_title: string
          p_track_engagement?: boolean
        }
        Returns: number
      }
      create_user_role_for_existing_user: {
        Args: {
          p_class_id: number
          p_name: string
          p_role: Database["public"]["Enums"]["app_role"]
          p_sis_id?: number
          p_user_id: string
        }
        Returns: number
      }
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
      deactivate_expired_polls: { Args: never; Returns: undefined }
      delete_assignment_with_all_data: {
        Args: { p_assignment_id: number; p_class_id: number }
        Returns: Json
      }
      delete_queued_messages_for_class: {
        Args: { p_class_id: number }
        Returns: {
          deleted_count: number
          deleted_message_ids: number[]
        }[]
      }
      delete_queued_messages_for_class_simple: {
        Args: { p_class_id: number }
        Returns: number
      }
      delete_system_notifications_by_campaign: {
        Args: { p_campaign_id: string; p_deleted_by?: string }
        Returns: number
      }
      enqueue_autograder_reruns: {
        Args: { p_class_id: number; p_submission_ids: number[] }
        Returns: Json
      }
      enqueue_discord_batch_role_sync: { Args: never; Returns: undefined }
      enqueue_discord_channel_creation: {
        Args: {
          p_channel_name?: string
          p_channel_type: Database["public"]["Enums"]["discord_channel_type"]
          p_class_id: number
          p_guild_id?: string
          p_resource_id?: number
        }
        Returns: undefined
      }
      enqueue_discord_help_request_message: {
        Args: { p_action?: string; p_help_request_id: number }
        Returns: undefined
      }
      enqueue_discord_invites_for_existing_users: {
        Args: { p_class_id: number; p_guild_id: string }
        Returns: undefined
      }
      enqueue_discord_queue_assignment_message: {
        Args: { p_action?: string; p_queue_assignment_id: number }
        Returns: undefined
      }
      enqueue_discord_register_commands: { Args: never; Returns: undefined }
      enqueue_discord_regrade_request_message: {
        Args: { p_action?: string; p_regrade_request_id: number }
        Returns: undefined
      }
      enqueue_discord_role_creation: {
        Args: { p_class_id: number; p_guild_id?: string; p_role_type: string }
        Returns: undefined
      }
      enqueue_discord_role_sync: {
        Args: {
          p_action?: string
          p_class_id: number
          p_role: Database["public"]["Enums"]["app_role"]
          p_user_id: string
        }
        Returns: undefined
      }
      enqueue_discord_roles_creation: {
        Args: { p_class_id: number; p_guild_id?: string }
        Returns: undefined
      }
      enqueue_github_archive_repo: {
        Args: {
          p_class_id: number
          p_debug_id?: string
          p_org: string
          p_repo: string
        }
        Returns: number
      }
      enqueue_github_create_repo:
        | {
            Args: {
              p_class_id: number
              p_course_slug: string
              p_debug_id?: string
              p_github_usernames: string[]
              p_is_template_repo?: boolean
              p_org: string
              p_repo_name: string
              p_template_repo: string
            }
            Returns: number
          }
        | {
            Args: {
              p_assignment_group_id?: number
              p_assignment_id?: number
              p_class_id: number
              p_course_slug: string
              p_debug_id?: string
              p_github_usernames: string[]
              p_is_template_repo?: boolean
              p_latest_template_sha?: string
              p_org: string
              p_profile_id?: string
              p_repo_name: string
              p_template_repo: string
            }
            Returns: number
          }
      enqueue_github_sync_repo_permissions: {
        Args: {
          p_class_id: number
          p_course_slug: string
          p_debug_id?: string
          p_github_usernames: string[]
          p_org: string
          p_repo: string
        }
        Returns: number
      }
      enqueue_github_sync_staff_team: {
        Args: {
          p_affected_user_id?: string
          p_class_id: number
          p_course_slug: string
          p_debug_id?: string
          p_org: string
        }
        Returns: number
      }
      enqueue_github_sync_student_team: {
        Args: {
          p_affected_user_id?: string
          p_class_id: number
          p_course_slug: string
          p_debug_id?: string
          p_org: string
        }
        Returns: number
      }
      enqueue_gradebook_row_recalculation: {
        Args: {
          p_class_id: number
          p_gradebook_id: number
          p_is_private: boolean
          p_reason?: string
          p_student_id: string
          p_trigger_id?: number
        }
        Returns: undefined
      }
      enqueue_gradebook_row_recalculation_batch: {
        Args: { p_rows: Json[] }
        Returns: undefined
      }
      finalize_submission_early: {
        Args: { this_assignment_id: number; this_profile_id: string }
        Returns: Json
      }
      generate_anon_name: { Args: never; Returns: string }
      get_all_class_metrics: { Args: never; Returns: Json }
      get_assignment_llm_metrics: { Args: never; Returns: Json }
      get_async_github_metrics: {
        Args: never
        Returns: {
          avg_latency_ms: number
          calls_total: number
          class_id: number
          errors_recent_1h: number
          errors_total: number
          method: string
        }[]
      }
      get_async_queue_sizes: {
        Args: never
        Returns: {
          async_queue_size: number
          dlq_queue_size: number
          gradebook_row_recalculate_queue_size: number
        }[]
      }
      get_circuit_breaker_statuses: {
        Args: never
        Returns: {
          is_open: boolean
          key: string
          open_until: string
          scope: string
          state: string
          trip_count: number
        }[]
      }
      get_github_api_metrics_recent: {
        Args: { p_window_seconds?: number }
        Returns: {
          avg_latency_ms: number
          calls: number
          class_id: number
          method: string
          status_code: number
        }[]
      }
      get_github_circuit: {
        Args: { p_key: string; p_scope: string }
        Returns: {
          open_until: string
          state: string
        }[]
      }
      get_gradebook_column_students_bulk: {
        Args: {
          p_gradebook_column_ids: Json
          p_limit?: number
          p_offset?: number
          p_student_ids: Json
        }
        Returns: {
          class_id: number
          created_at: string
          gradebook_column_id: number
          gradebook_id: number
          id: number
          incomplete_values: Json
          is_droppable: boolean
          is_excused: boolean
          is_missing: boolean
          is_private: boolean
          released: boolean
          score: number
          score_override: number
          score_override_note: string
          student_id: string
        }[]
      }
      get_gradebook_records_for_all_students: {
        Args: { p_class_id: number }
        Returns: Json
      }
      get_gradebook_records_for_all_students_array: {
        Args: { p_class_id: number }
        Returns: Json
      }
      get_instructor_dashboard_metrics: {
        Args: { p_class_id: number; p_now?: string }
        Returns: {
          assignment_id: number
          closed_or_resolved_regrade_requests: number
          due_date: string
          graded_submissions: number
          open_regrade_requests: number
          review_assignments_completed: number
          review_assignments_incomplete: number
          review_assignments_total: number
          section: string
          students_with_valid_extensions: number
          time_zone: string
          title: string
          total_submitters: number
        }[]
      }
      get_llm_tags_breakdown: { Args: never; Returns: Json }
      get_student_summary: {
        Args: { p_class_id: number; p_student_profile_id: string }
        Returns: Json
      }
      get_submissions_limits: {
        Args: { p_assignment_id: number }
        Returns: {
          created_at: string
          id: number
          max_submissions_count: number
          max_submissions_period_secs: number
        }[]
      }
      get_system_notification_stats: {
        Args: { p_requested_by?: string }
        Returns: {
          active_notifications: number
          notifications_by_display: Json
          notifications_by_severity: Json
          recent_campaigns: Json
          total_notifications: number
        }[]
      }
      get_user_id_by_email: {
        Args: { email: string }
        Returns: {
          id: string
        }[]
      }
      get_workflow_events_summary_for_class: {
        Args: { p_class_id: number }
        Returns: {
          actor_login: string | null
          assignment_id: number | null
          class_id: number
          completed_at: string | null
          conclusion: string | null
          created_at: string
          head_branch: string | null
          head_sha: string | null
          id: number
          in_progress_at: string | null
          profile_id: string | null
          queue_time_seconds: number | null
          repository_name: string | null
          requested_at: string | null
          run_attempt: number
          run_number: number | null
          run_time_seconds: number | null
          triggering_actor_login: string | null
          updated_at: string
          workflow_name: string | null
          workflow_path: string | null
          workflow_run_id: number
        }[]
        SetofOptions: {
          from: "*"
          to: "workflow_runs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_workflow_statistics: {
        Args: { p_class_id: number; p_duration_hours?: number }
        Returns: {
          avg_queue_time_seconds: number
          avg_run_time_seconds: number
          class_id: number
          completed_runs: number
          duration_hours: number
          error_count: number
          error_rate: number
          failed_runs: number
          in_progress_runs: number
          period_end: string
          period_start: string
          success_rate: number
          total_runs: number
        }[]
      }
      gift_tokens_to_student: {
        Args: {
          p_assignment_id: number
          p_class_id: number
          p_note?: string
          p_student_id: string
          p_tokens_to_gift: number
        }
        Returns: number
      }
      gradebook_auto_layout: {
        Args: { p_gradebook_id: number }
        Returns: undefined
      }
      gradebook_column_move_left: {
        Args: { p_column_id: number }
        Returns: {
          class_id: number
          created_at: string
          dependencies: Json | null
          description: string | null
          external_data: Json | null
          gradebook_id: number
          id: number
          max_score: number | null
          name: string
          released: boolean
          render_expression: string | null
          score_expression: string | null
          show_calculated_ranges: boolean
          show_max_score: boolean
          slug: string
          sort_order: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "gradebook_columns"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      gradebook_column_move_right: {
        Args: { p_column_id: number }
        Returns: {
          class_id: number
          created_at: string
          dependencies: Json | null
          description: string | null
          external_data: Json | null
          gradebook_id: number
          id: number
          max_score: number | null
          name: string
          released: boolean
          render_expression: string | null
          score_expression: string | null
          show_calculated_ranges: boolean
          show_max_score: boolean
          slug: string
          sort_order: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "gradebook_columns"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      help_request_is_private: {
        Args: { p_help_request_id: number }
        Returns: boolean
      }
      help_request_notification: {
        Args: {
          p_action: string
          p_assignee_name: string
          p_assignee_profile_id: string
          p_class_id: number
          p_creator_name: string
          p_creator_profile_id: string
          p_help_queue_id: number
          p_help_queue_name: string
          p_help_request_id: number
          p_is_private: boolean
          p_request_preview: string
          p_status: string
        }
        Returns: undefined
      }
      import_gradebook_scores: {
        Args: { p_class_id: number; p_updates: Json }
        Returns: boolean
      }
      insert_discord_message: {
        Args: {
          p_class_id: number
          p_discord_channel_id: string
          p_discord_message_id: string
          p_resource_id: number
          p_resource_type: string
        }
        Returns: undefined
      }
      invoke_calendar_sync_background_task: { Args: never; Returns: undefined }
      invoke_discord_async_worker_background_task: {
        Args: never
        Returns: undefined
      }
      invoke_email_batch_processor_background_task: {
        Args: never
        Returns: undefined
      }
      invoke_github_async_worker_background_task: {
        Args: never
        Returns: undefined
      }
      invoke_gradebook_recalculation_background_task: {
        Args: never
        Returns: undefined
      }
      is_allowed_grader_key: {
        Args: { class: number; graderkey: string }
        Returns: boolean
      }
      is_in_class: {
        Args: { classid: number; userid: string }
        Returns: boolean
      }
      is_instructor_for_class:
        | { Args: { _class_id: number; _person_id: string }; Returns: boolean }
        | { Args: { _person_id: string; classid: number }; Returns: boolean }
      is_instructor_for_student: {
        Args: { _person_id: string; _student_id: string }
        Returns: boolean
      }
      log_api_gateway_call: {
        Args: {
          p_class_id?: number
          p_debug_id?: string
          p_latency_ms?: number
          p_message_processed_at?: string
          p_method: string
          p_status_code: number
        }
        Returns: undefined
      }
      log_flashcard_interaction: {
        Args: {
          p_action: string
          p_card_id?: number
          p_class_id: number
          p_deck_id: number
          p_duration_on_card_ms: number
          p_student_id: string
        }
        Returns: undefined
      }
      mark_discord_invite_used: {
        Args: { p_guild_id: string; p_user_id: string }
        Returns: undefined
      }
      only_calendar_or_discord_ids_changed: {
        Args: { new_row: Database["public"]["Tables"]["classes"]["Row"] }
        Returns: boolean
      }
      only_discord_ids_changed: {
        Args: { new_row: Database["public"]["Tables"]["classes"]["Row"] }
        Returns: boolean
      }
      open_github_circuit: {
        Args: {
          p_event: string
          p_key: string
          p_reason?: string
          p_retry_after_seconds?: number
          p_scope: string
        }
        Returns: number
      }
      process_calendar_announcements: { Args: never; Returns: Json }
      queue_repository_syncs: {
        Args: { p_repository_ids: number[] }
        Returns: Json
      }
      recalculate_discussion_thread_children_counts: {
        Args: { target_class_id?: number }
        Returns: number
      }
      recalculate_gradebook_columns_in_range: {
        Args: { end_id: number; start_id: number }
        Returns: undefined
      }
      record_github_async_error: {
        Args: { p_error_data: Json; p_method: string; p_org: string }
        Returns: undefined
      }
      refresh_realtime_subscription: {
        Args: {
          p_channel: string
          p_client_id: string
          p_lease_seconds?: number
        }
        Returns: undefined
      }
      register_realtime_subscription: {
        Args: {
          p_channel: string
          p_class_id?: number
          p_client_id: string
          p_lease_seconds?: number
          p_profile_id?: string
        }
        Returns: undefined
      }
      release_all_grading_reviews_for_assignment: {
        Args: { assignment_id: number }
        Returns: number
      }
      reset_all_flashcard_progress: {
        Args: { p_card_ids: number[]; p_class_id: number; p_student_id: string }
        Returns: undefined
      }
      safe_broadcast: {
        Args: {
          p_channel: string
          p_event: string
          p_payload: Json
          p_private: boolean
        }
        Returns: undefined
      }
      send_signup_welcome_message: {
        Args: { p_user_id: string }
        Returns: boolean
      }
      sis_sync_enrollment: {
        Args: { p_class_id: number; p_roster_data: Json; p_sync_options?: Json }
        Returns: Json
      }
      soft_delete_survey: {
        Args: { p_survey_id: string; p_survey_logical_id: string }
        Returns: undefined
      }
      submission_set_active: {
        Args: { _submission_id: number }
        Returns: boolean
      }
      sync_existing_users_after_roles_created: {
        Args: { p_class_id: number }
        Returns: undefined
      }
      sync_lab_section_meetings: {
        Args: { lab_section_id_param: number }
        Returns: undefined
      }
      sync_staff_github_team: {
        Args: { class_id: number; user_id?: string }
        Returns: undefined
      }
      sync_student_github_team: {
        Args: { class_id: number; user_id?: string }
        Returns: undefined
      }
      test_discussion_thread_insert_performance: {
        Args: {
          num_inserts?: number
          test_author_id: string
          test_class_id: number
          test_topic_id: number
        }
        Returns: {
          duration_ms: number
          inserts_per_second: number
          operation: string
        }[]
      }
      trigger_discord_role_sync_for_user: {
        Args: { p_class_id?: number }
        Returns: Json
      }
      trigger_sis_sync: { Args: { p_class_id?: number }; Returns: Json }
      unregister_realtime_subscription: {
        Args: { p_channel: string; p_client_id: string }
        Returns: undefined
      }
      unrelease_all_grading_reviews_for_assignment: {
        Args: { assignment_id: number }
        Returns: number
      }
      update_api_gateway_call: {
        Args: { p_latency_ms?: number; p_log_id: number; p_status_code: number }
        Returns: undefined
      }
      update_card_progress: {
        Args: {
          p_card_id: number
          p_class_id: number
          p_is_mastered: boolean
          p_student_id: string
        }
        Returns: undefined
      }
      update_class_late_tokens_per_student: {
        Args: { p_class_id: number; p_late_tokens_per_student: number }
        Returns: undefined
      }
      update_gradebook_column_student_with_recalc: {
        Args: { p_id: number; p_updates: Json }
        Returns: undefined
      }
      update_gradebook_column_students_batch_with_recalc: {
        Args: { p_updates: Json[] }
        Returns: Json
      }
      update_gradebook_row: {
        Args: {
          p_class_id: number
          p_expected_version: number
          p_gradebook_id: number
          p_is_private: boolean
          p_student_id: string
          p_updates: Json[]
        }
        Returns: number
      }
      update_gradebook_rows_batch: {
        Args: { p_batch_updates: Json[] }
        Returns: Json
      }
      update_regrade_request_points: {
        Args: {
          closed_points?: number
          profile_id: string
          regrade_request_id: number
          resolved_points?: number
        }
        Returns: boolean
      }
      update_regrade_request_status: {
        Args: {
          closed_points?: number
          new_status: Database["public"]["Enums"]["regrade_status"]
          profile_id: string
          regrade_request_id: number
          resolved_points?: number
        }
        Returns: boolean
      }
      update_sis_sync_status: {
        Args: {
          p_course_id: number
          p_course_section_id?: number
          p_lab_section_id?: number
          p_sync_message?: string
          p_sync_status?: string
        }
        Returns: number
      }
      user_is_in_help_request: {
        Args: { p_help_request_id: number; p_user_id?: string }
        Returns: boolean
      }
    }
    Enums: {
      allowed_modes: "private" | "public" | "question" | "note"
      app_role: "admin" | "instructor" | "grader" | "student"
      assignment_group_join_status:
        | "pending"
        | "approved"
        | "rejected"
        | "withdrawn"
      assignment_group_mode: "individual" | "groups" | "both"
      day_of_week:
        | "sunday"
        | "monday"
        | "tuesday"
        | "wednesday"
        | "thursday"
        | "friday"
        | "saturday"
      discord_channel_type:
        | "general"
        | "assignment"
        | "lab"
        | "office_hours"
        | "regrades"
        | "scheduling"
        | "operations"
      discord_resource_type: "help_request" | "regrade_request"
      discussion_notification_type: "immediate" | "digest" | "disabled"
      feedback_visibility:
        | "visible"
        | "hidden"
        | "after_due_date"
        | "after_published"
      flashcard_actions:
        | "deck_viewed"
        | "card_prompt_viewed"
        | "card_answer_viewed"
        | "card_marked_got_it"
        | "card_marked_keep_trying"
        | "card_returned_to_deck"
        | "deck_progress_reset_all"
        | "deck_progress_reset_card"
      github_async_method:
        | "sync_student_team"
        | "sync_staff_team"
        | "create_repo"
        | "sync_repo_permissions"
        | "archive_repo_and_lock"
        | "rerun_autograder"
        | "sync_repo_to_handout"
      help_queue_type: "text" | "video" | "in_person"
      help_request_creation_notification: "all" | "only_active_queue" | "none"
      help_request_status: "open" | "in_progress" | "resolved" | "closed"
      location_type: "remote" | "in_person" | "hybrid"
      moderation_action_type: "warning" | "temporary_ban" | "permanent_ban"
      regrade_status: "draft" | "opened" | "resolved" | "escalated" | "closed"
      review_round:
        | "self-review"
        | "grading-review"
        | "meta-grading-review"
        | "code-walk"
      rubric_check_student_visibility:
        | "always"
        | "if_released"
        | "if_applied"
        | "never"
      student_help_activity_type:
        | "request_created"
        | "request_updated"
        | "message_sent"
        | "request_resolved"
        | "video_joined"
        | "video_left"
      survey_status: "draft" | "published" | "closed"
      survey_type: "assign_all" | "specific" | "peer"
      template_scope: "global" | "course"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  pgmq_public: {
    Enums: {},
  },
  public: {
    Enums: {
      allowed_modes: ["private", "public", "question", "note"],
      app_role: ["admin", "instructor", "grader", "student"],
      assignment_group_join_status: [
        "pending",
        "approved",
        "rejected",
        "withdrawn",
      ],
      assignment_group_mode: ["individual", "groups", "both"],
      day_of_week: [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
      ],
      discord_channel_type: [
        "general",
        "assignment",
        "lab",
        "office_hours",
        "regrades",
        "scheduling",
        "operations",
      ],
      discord_resource_type: ["help_request", "regrade_request"],
      discussion_notification_type: ["immediate", "digest", "disabled"],
      feedback_visibility: [
        "visible",
        "hidden",
        "after_due_date",
        "after_published",
      ],
      flashcard_actions: [
        "deck_viewed",
        "card_prompt_viewed",
        "card_answer_viewed",
        "card_marked_got_it",
        "card_marked_keep_trying",
        "card_returned_to_deck",
        "deck_progress_reset_all",
        "deck_progress_reset_card",
      ],
      github_async_method: [
        "sync_student_team",
        "sync_staff_team",
        "create_repo",
        "sync_repo_permissions",
        "archive_repo_and_lock",
        "rerun_autograder",
        "sync_repo_to_handout",
      ],
      help_queue_type: ["text", "video", "in_person"],
      help_request_creation_notification: ["all", "only_active_queue", "none"],
      help_request_status: ["open", "in_progress", "resolved", "closed"],
      location_type: ["remote", "in_person", "hybrid"],
      moderation_action_type: ["warning", "temporary_ban", "permanent_ban"],
      regrade_status: ["draft", "opened", "resolved", "escalated", "closed"],
      review_round: [
        "self-review",
        "grading-review",
        "meta-grading-review",
        "code-walk",
      ],
      rubric_check_student_visibility: [
        "always",
        "if_released",
        "if_applied",
        "never",
      ],
      student_help_activity_type: [
        "request_created",
        "request_updated",
        "message_sent",
        "request_resolved",
        "video_joined",
        "video_left",
      ],
      survey_status: ["draft", "published", "closed"],
      survey_type: ["assign_all", "specific", "peer"],
      template_scope: ["global", "course"],
    },
  },
} as const

