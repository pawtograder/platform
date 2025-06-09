export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  pgmq_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      archive: {
        Args: { queue_name: string; message_id: number };
        Returns: boolean;
      };
      delete: {
        Args: { queue_name: string; message_id: number };
        Returns: boolean;
      };
      pop: {
        Args: { queue_name: string };
        Returns: unknown[];
      };
      read: {
        Args: { queue_name: string; sleep_seconds: number; n: number };
        Returns: unknown[];
      };
      send: {
        Args: { queue_name: string; message: Json; sleep_seconds?: number };
        Returns: number[];
      };
      send_batch: {
        Args: { queue_name: string; messages: Json[]; sleep_seconds?: number };
        Returns: number[];
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      assignment_due_date_exceptions: {
        Row: {
          assignment_group_id: number | null;
          assignment_id: number;
          class_id: number | null;
          created_at: string;
          creator_id: string;
          hours: number;
          id: number;
          minutes: number;
          note: string | null;
          student_id: string | null;
          tokens_consumed: number;
        };
        Insert: {
          assignment_group_id?: number | null;
          assignment_id: number;
          class_id?: number | null;
          created_at?: string;
          creator_id: string;
          hours: number;
          id?: number;
          minutes?: number;
          note?: string | null;
          student_id?: string | null;
          tokens_consumed?: number;
        };
        Update: {
          assignment_group_id?: number | null;
          assignment_id?: number;
          class_id?: number | null;
          created_at?: string;
          creator_id?: string;
          hours?: number;
          id?: number;
          minutes?: number;
          note?: string | null;
          student_id?: string | null;
          tokens_consumed?: number;
        };
        Relationships: [
          {
            foreignKeyName: "assignment_late_exception_assignment_group_id_fkey";
            columns: ["assignment_group_id"];
            isOneToOne: false;
            referencedRelation: "assignment_groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_late_exception_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "assignments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_late_exception_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "assignment_late_exception_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "assignment_late_exception_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_late_exception_instructor_id_fkey";
            columns: ["creator_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_late_exception_instructor_id_fkey";
            columns: ["creator_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "assignment_late_exception_student_id_fkey";
            columns: ["student_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_late_exception_student_id_fkey";
            columns: ["student_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          }
        ];
      };
      assignment_group_invitations: {
        Row: {
          assignment_group_id: number;
          class_id: number;
          created_at: string;
          id: number;
          invitee: string;
          inviter: string;
        };
        Insert: {
          assignment_group_id: number;
          class_id: number;
          created_at?: string;
          id?: number;
          invitee?: string;
          inviter?: string;
        };
        Update: {
          assignment_group_id?: number;
          class_id?: number;
          created_at?: string;
          id?: number;
          invitee?: string;
          inviter?: string;
        };
        Relationships: [
          {
            foreignKeyName: "assignment_group_invitation_assignment_group_id_fkey";
            columns: ["assignment_group_id"];
            isOneToOne: false;
            referencedRelation: "assignment_groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_group_invitation_invitee_fkey";
            columns: ["invitee"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_group_invitation_invitee_fkey";
            columns: ["invitee"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "assignment_group_invitation_inviter_fkey";
            columns: ["inviter"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_group_invitation_inviter_fkey";
            columns: ["inviter"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "assignment_group_invitations_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          }
        ];
      };
      assignment_group_join_request: {
        Row: {
          assignment_group_id: number;
          assignment_id: number;
          class_id: number;
          created_at: string;
          decided_at: string | null;
          decision_maker: string | null;
          id: number;
          profile_id: string;
          status: Database["public"]["Enums"]["assignment_group_join_status"];
        };
        Insert: {
          assignment_group_id: number;
          assignment_id: number;
          class_id: number;
          created_at?: string;
          decided_at?: string | null;
          decision_maker?: string | null;
          id?: number;
          profile_id: string;
          status?: Database["public"]["Enums"]["assignment_group_join_status"];
        };
        Update: {
          assignment_group_id?: number;
          assignment_id?: number;
          class_id?: number;
          created_at?: string;
          decided_at?: string | null;
          decision_maker?: string | null;
          id?: number;
          profile_id?: string;
          status?: Database["public"]["Enums"]["assignment_group_join_status"];
        };
        Relationships: [
          {
            foreignKeyName: "assignment_group_join_request_assignment_group_id_fkey";
            columns: ["assignment_group_id"];
            isOneToOne: false;
            referencedRelation: "assignment_groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_group_join_request_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "assignments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_group_join_request_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "assignment_group_join_request_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "assignment_group_join_request_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_group_join_request_decision_maker_fkey";
            columns: ["decision_maker"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_group_join_request_decision_maker_fkey";
            columns: ["decision_maker"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "assignment_group_join_request_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_group_join_request_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "assignment_group_join_request_profile_id_fkey1";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "submissions_agg";
            referencedColumns: ["profile_id"];
          },
          {
            foreignKeyName: "assignment_group_join_request_profile_id_fkey1";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "user_roles";
            referencedColumns: ["private_profile_id"];
          }
        ];
      };
      assignment_groups: {
        Row: {
          assignment_id: number;
          class_id: number;
          created_at: string;
          id: number;
          name: string;
        };
        Insert: {
          assignment_id: number;
          class_id: number;
          created_at?: string;
          id?: number;
          name: string;
        };
        Update: {
          assignment_id?: number;
          class_id?: number;
          created_at?: string;
          id?: number;
          name?: string;
        };
        Relationships: [
          {
            foreignKeyName: "assignment_groups_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "assignments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_groups_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "assignment_groups_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "assignment_groups_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          }
        ];
      };
      assignment_groups_members: {
        Row: {
          added_by: string;
          assignment_group_id: number;
          assignment_id: number;
          class_id: number;
          created_at: string;
          id: number;
          profile_id: string;
        };
        Insert: {
          added_by: string;
          assignment_group_id: number;
          assignment_id: number;
          class_id: number;
          created_at?: string;
          id?: number;
          profile_id?: string;
        };
        Update: {
          added_by?: string;
          assignment_group_id?: number;
          assignment_id?: number;
          class_id?: number;
          created_at?: string;
          id?: number;
          profile_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "assignment_groups_members_added_by_fkey";
            columns: ["added_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_groups_members_added_by_fkey";
            columns: ["added_by"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "assignment_groups_members_assignment_group_id_fkey";
            columns: ["assignment_group_id"];
            isOneToOne: false;
            referencedRelation: "assignment_groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_groups_members_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "assignments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_groups_members_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "assignment_groups_members_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "assignment_groups_members_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_groups_members_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_groups_members_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "assignment_groups_members_profile_id_fkey1";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "submissions_agg";
            referencedColumns: ["profile_id"];
          },
          {
            foreignKeyName: "assignment_groups_members_profile_id_fkey1";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "user_roles";
            referencedColumns: ["private_profile_id"];
          }
        ];
      };
      assignment_handout_commits: {
        Row: {
          assignment_id: number;
          author: string | null;
          class_id: number | null;
          created_at: string;
          id: number;
          message: string;
          sha: string;
        };
        Insert: {
          assignment_id: number;
          author?: string | null;
          class_id?: number | null;
          created_at?: string;
          id?: number;
          message: string;
          sha: string;
        };
        Update: {
          assignment_id?: number;
          author?: string | null;
          class_id?: number | null;
          created_at?: string;
          id?: number;
          message?: string;
          sha?: string;
        };
        Relationships: [
          {
            foreignKeyName: "assignment_handout_commit_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "assignments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_handout_commit_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "assignment_handout_commit_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "assignment_handout_commits_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          }
        ];
      };
      assignments: {
        Row: {
          allow_student_formed_groups: boolean | null;
          archived_at: string | null;
          autograder_points: number | null;
          class_id: number;
          created_at: string;
          description: string | null;
          due_date: string;
          grading_rubric_id: number | null;
          group_config: Database["public"]["Enums"]["assignment_group_mode"];
          group_formation_deadline: string | null;
          has_autograder: boolean;
          has_handgrader: boolean;
          id: number;
          latest_template_sha: string | null;
          max_group_size: number | null;
          max_late_tokens: number;
          meta_grading_rubric_id: number | null;
          min_group_size: number | null;
          release_date: string | null;
          self_review_rubric_id: number | null;
          self_review_setting_id: number;
          slug: string | null;
          student_repo_prefix: string | null;
          template_repo: string | null;
          title: string;
          total_points: number | null;
        };
        Insert: {
          allow_student_formed_groups?: boolean | null;
          archived_at?: string | null;
          autograder_points?: number | null;
          class_id: number;
          created_at?: string;
          description?: string | null;
          due_date: string;
          grading_rubric_id?: number | null;
          group_config: Database["public"]["Enums"]["assignment_group_mode"];
          group_formation_deadline?: string | null;
          has_autograder?: boolean;
          has_handgrader?: boolean;
          id?: number;
          latest_template_sha?: string | null;
          max_group_size?: number | null;
          max_late_tokens?: number;
          meta_grading_rubric_id?: number | null;
          min_group_size?: number | null;
          release_date?: string | null;
          self_review_rubric_id?: number | null;
          self_review_setting_id: number;
          slug?: string | null;
          student_repo_prefix?: string | null;
          template_repo?: string | null;
          title: string;
          total_points?: number | null;
        };
        Update: {
          allow_student_formed_groups?: boolean | null;
          archived_at?: string | null;
          autograder_points?: number | null;
          class_id?: number;
          created_at?: string;
          description?: string | null;
          due_date?: string;
          grading_rubric_id?: number | null;
          group_config?: Database["public"]["Enums"]["assignment_group_mode"];
          group_formation_deadline?: string | null;
          has_autograder?: boolean;
          has_handgrader?: boolean;
          id?: number;
          latest_template_sha?: string | null;
          max_group_size?: number | null;
          max_late_tokens?: number;
          meta_grading_rubric_id?: number | null;
          min_group_size?: number | null;
          release_date?: string | null;
          self_review_rubric_id?: number | null;
          self_review_setting_id?: number;
          slug?: string | null;
          student_repo_prefix?: string | null;
          template_repo?: string | null;
          title?: string;
          total_points?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "assignments_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignments_meta_grading_rubric_id_fkey";
            columns: ["meta_grading_rubric_id"];
            isOneToOne: false;
            referencedRelation: "rubrics";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignments_rubric_id_fkey";
            columns: ["grading_rubric_id"];
            isOneToOne: false;
            referencedRelation: "rubrics";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignments_self_review_rubric_id_fkey";
            columns: ["self_review_rubric_id"];
            isOneToOne: false;
            referencedRelation: "rubrics";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignments_self_review_setting_fkey";
            columns: ["self_review_setting_id"];
            isOneToOne: false;
            referencedRelation: "assignment_self_review_settings";
            referencedColumns: ["id"];
          }
        ];
      };
      audit: {
        Row: {
          class_id: number;
          created_at: string;
          id: number;
          ip_addr: string | null;
          new: Json | null;
          old: Json | null;
          table: string;
          user_id: string | null;
        };
        Insert: {
          class_id: number;
          created_at?: string;
          id?: number;
          ip_addr?: string | null;
          new?: Json | null;
          old?: Json | null;
          table: string;
          user_id?: string | null;
        };
        Update: {
          class_id?: number;
          created_at?: string;
          id?: number;
          ip_addr?: string | null;
          new?: Json | null;
          old?: Json | null;
          table?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "audit_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["user_id"];
          }
        ];
      };
      autograder: {
        Row: {
          class_id: number | null;
          config: Json | null;
          created_at: string;
          grader_commit_sha: string | null;
          grader_repo: string | null;
          id: number;
          latest_autograder_sha: string | null;
          max_submissions_count: number | null;
          max_submissions_period_secs: number | null;
          workflow_sha: string | null;
        };
        Insert: {
          class_id?: number | null;
          config?: Json | null;
          created_at?: string;
          grader_commit_sha?: string | null;
          grader_repo?: string | null;
          id: number;
          latest_autograder_sha?: string | null;
          max_submissions_count?: number | null;
          max_submissions_period_secs?: number | null;
          workflow_sha?: string | null;
        };
        Update: {
          class_id?: number | null;
          config?: Json | null;
          created_at?: string;
          grader_commit_sha?: string | null;
          grader_repo?: string | null;
          id?: number;
          latest_autograder_sha?: string | null;
          max_submissions_count?: number | null;
          max_submissions_period_secs?: number | null;
          workflow_sha?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "autograder_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grader_configs_id_fkey";
            columns: ["id"];
            isOneToOne: true;
            referencedRelation: "assignments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grader_configs_id_fkey";
            columns: ["id"];
            isOneToOne: true;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "grader_configs_id_fkey";
            columns: ["id"];
            isOneToOne: true;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["assignment_id"];
          }
        ];
      };
      autograder_commits: {
        Row: {
          author: string | null;
          autograder_id: number;
          class_id: number;
          created_at: string;
          id: number;
          message: string;
          ref: string;
          sha: string;
        };
        Insert: {
          author?: string | null;
          autograder_id: number;
          class_id: number;
          created_at?: string;
          id?: number;
          message: string;
          ref: string;
          sha: string;
        };
        Update: {
          author?: string | null;
          autograder_id?: number;
          class_id?: number;
          created_at?: string;
          id?: number;
          message?: string;
          ref?: string;
          sha?: string;
        };
        Relationships: [
          {
            foreignKeyName: "autograder_commits_assignment_id_fkey";
            columns: ["autograder_id"];
            isOneToOne: false;
            referencedRelation: "assignments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "autograder_commits_assignment_id_fkey";
            columns: ["autograder_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "autograder_commits_assignment_id_fkey";
            columns: ["autograder_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "autograder_commits_autograder_id_fkey";
            columns: ["autograder_id"];
            isOneToOne: false;
            referencedRelation: "autograder";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "autograder_commits_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "autograder_commits_class_id_fkey1";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          }
        ];
      };
      autograder_regression_test: {
        Row: {
          autograder_id: number;
          created_at: string;
          id: number;
          repository: string;
        };
        Insert: {
          autograder_id: number;
          created_at?: string;
          id?: number;
          repository: string;
        };
        Update: {
          autograder_id?: number;
          created_at?: string;
          id?: number;
          repository?: string;
        };
        Relationships: [
          {
            foreignKeyName: "autograder_regression_test_autograder_id_fkey";
            columns: ["autograder_id"];
            isOneToOne: false;
            referencedRelation: "autograder";
            referencedColumns: ["id"];
          }
        ];
      };
      class_sections: {
        Row: {
          canvas_course_id: number | null;
          canvas_course_section_id: number | null;
          class_id: number;
          created_at: string;
          id: number;
          name: string;
        };
        Insert: {
          canvas_course_id?: number | null;
          canvas_course_section_id?: number | null;
          class_id: number;
          created_at?: string;
          id?: number;
          name: string;
        };
        Update: {
          canvas_course_id?: number | null;
          canvas_course_section_id?: number | null;
          class_id?: number;
          created_at?: string;
          id?: number;
          name?: string;
        };
        Relationships: [
          {
            foreignKeyName: "class_sections_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          }
        ];
      };
      classes: {
        Row: {
          created_at: string;
          features: Json | null;
          github_org: string | null;
          id: number;
          is_demo: boolean;
          late_tokens_per_student: number;
          name: string | null;
          semester: number | null;
          slug: string | null;
          time_zone: string | null;
        };
        Insert: {
          created_at?: string;
          features?: Json | null;
          github_org?: string | null;
          id?: number;
          is_demo?: boolean;
          late_tokens_per_student?: number;
          name?: string | null;
          semester?: number | null;
          slug?: string | null;
          time_zone?: string | null;
        };
        Update: {
          created_at?: string;
          features?: Json | null;
          github_org?: string | null;
          id?: number;
          is_demo?: boolean;
          late_tokens_per_student?: number;
          name?: string | null;
          semester?: number | null;
          slug?: string | null;
          time_zone?: string | null;
        };
        Relationships: [];
      };
      discussion_thread_likes: {
        Row: {
          created_at: string;
          creator: string;
          discussion_thread: number;
          emoji: string;
          id: number;
        };
        Insert: {
          created_at?: string;
          creator: string;
          discussion_thread: number;
          emoji: string;
          id?: number;
        };
        Update: {
          created_at?: string;
          creator?: string;
          discussion_thread?: number;
          emoji?: string;
          id?: number;
        };
        Relationships: [
          {
            foreignKeyName: "discussion_thread_likes_discussion_thread_fkey";
            columns: ["discussion_thread"];
            isOneToOne: false;
            referencedRelation: "discussion_threads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "discussion_thread_likes_user_fkey";
            columns: ["creator"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "discussion_thread_likes_user_fkey";
            columns: ["creator"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          }
        ];
      };
      discussion_thread_read_status: {
        Row: {
          created_at: string;
          discussion_thread_id: number;
          discussion_thread_root_id: number;
          id: number;
          read_at: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          discussion_thread_id: number;
          discussion_thread_root_id: number;
          id?: number;
          read_at?: string | null;
          user_id?: string;
        };
        Update: {
          created_at?: string;
          discussion_thread_id?: number;
          discussion_thread_root_id?: number;
          id?: number;
          read_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "discussion_thread_read_status_discussion_thread_id_fkey";
            columns: ["discussion_thread_id"];
            isOneToOne: false;
            referencedRelation: "discussion_threads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "discussion_thread_read_status_discussion_thread_root_id_fkey";
            columns: ["discussion_thread_root_id"];
            isOneToOne: false;
            referencedRelation: "discussion_threads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "discussion_thread_read_status_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["user_id"];
          }
        ];
      };
      discussion_thread_watchers: {
        Row: {
          class_id: number;
          created_at: string;
          discussion_thread_root_id: number;
          enabled: boolean;
          id: number;
          user_id: string;
        };
        Insert: {
          class_id: number;
          created_at?: string;
          discussion_thread_root_id: number;
          enabled?: boolean;
          id?: number;
          user_id: string;
        };
        Update: {
          class_id?: number;
          created_at?: string;
          discussion_thread_root_id?: number;
          enabled?: boolean;
          id?: number;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "discussion_thread_watchers_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "discussion_thread_watchers_discussion_thread_root_id_fkey";
            columns: ["discussion_thread_root_id"];
            isOneToOne: false;
            referencedRelation: "discussion_threads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "discussion_thread_watchers_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["user_id"];
          }
        ];
      };
      discussion_threads: {
        Row: {
          answer: number | null;
          author: string;
          body: string;
          children_count: number;
          class_id: number;
          created_at: string;
          draft: boolean;
          edited_at: string | null;
          id: number;
          instructors_only: boolean;
          is_question: boolean;
          likes_count: number;
          ordinal: number | null;
          parent: number | null;
          root: number | null;
          root_class_id: number | null;
          subject: string;
          topic_id: number;
        };
        Insert: {
          answer?: number | null;
          author: string;
          body: string;
          children_count?: number;
          class_id: number;
          created_at?: string;
          draft?: boolean;
          edited_at?: string | null;
          id?: number;
          instructors_only?: boolean;
          is_question?: boolean;
          likes_count?: number;
          ordinal?: number | null;
          parent?: number | null;
          root?: number | null;
          root_class_id?: number | null;
          subject: string;
          topic_id: number;
        };
        Update: {
          answer?: number | null;
          author?: string;
          body?: string;
          children_count?: number;
          class_id?: number;
          created_at?: string;
          draft?: boolean;
          edited_at?: string | null;
          id?: number;
          instructors_only?: boolean;
          is_question?: boolean;
          likes_count?: number;
          ordinal?: number | null;
          parent?: number | null;
          root?: number | null;
          root_class_id?: number | null;
          subject?: string;
          topic_id?: number;
        };
        Relationships: [
          {
            foreignKeyName: "dicussion_threads_author_fkey";
            columns: ["author"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "dicussion_threads_author_fkey";
            columns: ["author"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "dicussion_threads_class_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "dicussion_threads_parent_fkey";
            columns: ["parent"];
            isOneToOne: false;
            referencedRelation: "discussion_threads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "discussion_threads_answer_fkey";
            columns: ["answer"];
            isOneToOne: false;
            referencedRelation: "discussion_threads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "discussion_threads_root_fkey";
            columns: ["root"];
            isOneToOne: false;
            referencedRelation: "discussion_threads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "discussion_threads_topic_id_fkey";
            columns: ["topic_id"];
            isOneToOne: false;
            referencedRelation: "discussion_topics";
            referencedColumns: ["id"];
          }
        ];
      };
      discussion_topics: {
        Row: {
          class_id: number;
          color: string;
          created_at: string;
          description: string;
          id: number;
          ordinal: number;
          topic: string;
        };
        Insert: {
          class_id: number;
          color: string;
          created_at?: string;
          description: string;
          id?: number;
          ordinal?: number;
          topic: string;
        };
        Update: {
          class_id?: number;
          color?: string;
          created_at?: string;
          description?: string;
          id?: number;
          ordinal?: number;
          topic?: string;
        };
        Relationships: [
          {
            foreignKeyName: "discussion_topics_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          }
        ];
      };
      grader_keys: {
        Row: {
          class_id: number;
          created_at: string;
          id: number;
          key: string;
          note: string | null;
        };
        Insert: {
          class_id: number;
          created_at?: string;
          id?: number;
          key?: string;
          note?: string | null;
        };
        Update: {
          class_id?: number;
          created_at?: string;
          id?: number;
          key?: string;
          note?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "grader_keys_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          }
        ];
      };
      grader_result_output: {
        Row: {
          assignment_group_id: number | null;
          class_id: number;
          created_at: string;
          format: string;
          grader_result_id: number;
          id: number;
          output: string;
          student_id: string | null;
          visibility: Database["public"]["Enums"]["feedback_visibility"];
        };
        Insert: {
          assignment_group_id?: number | null;
          class_id: number;
          created_at?: string;
          format: string;
          grader_result_id: number;
          id?: number;
          output: string;
          student_id?: string | null;
          visibility: Database["public"]["Enums"]["feedback_visibility"];
        };
        Update: {
          assignment_group_id?: number | null;
          class_id?: number;
          created_at?: string;
          format?: string;
          grader_result_id?: number;
          id?: number;
          output?: string;
          student_id?: string | null;
          visibility?: Database["public"]["Enums"]["feedback_visibility"];
        };
        Relationships: [
          {
            foreignKeyName: "grader_result_output_assignment_group_id_fkey";
            columns: ["assignment_group_id"];
            isOneToOne: false;
            referencedRelation: "assignment_groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grader_result_output_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grader_result_output_grader_result_id_fkey";
            columns: ["grader_result_id"];
            isOneToOne: false;
            referencedRelation: "grader_results";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grader_result_output_student_id_fkey";
            columns: ["student_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grader_result_output_student_id_fkey";
            columns: ["student_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          }
        ];
      };
      grader_result_test_output: {
        Row: {
          class_id: number;
          created_at: string;
          grader_result_test_id: number;
          id: number;
          output: string;
          output_format: string;
        };
        Insert: {
          class_id: number;
          created_at?: string;
          grader_result_test_id: number;
          id?: number;
          output: string;
          output_format: string;
        };
        Update: {
          class_id?: number;
          created_at?: string;
          grader_result_test_id?: number;
          id?: number;
          output?: string;
          output_format?: string;
        };
        Relationships: [
          {
            foreignKeyName: "grader_result_test_output_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grader_result_test_output_grader_result_test_id_fkey";
            columns: ["grader_result_test_id"];
            isOneToOne: false;
            referencedRelation: "grader_result_tests";
            referencedColumns: ["id"];
          }
        ];
      };
      grader_result_tests: {
        Row: {
          assignment_group_id: number | null;
          class_id: number;
          created_at: string;
          extra_data: Json | null;
          grader_result_id: number;
          id: number;
          is_released: boolean;
          max_score: number | null;
          name: string;
          name_format: string;
          output: string | null;
          output_format: string | null;
          part: string | null;
          score: number | null;
          student_id: string | null;
          submission_id: number | null;
        };
        Insert: {
          assignment_group_id?: number | null;
          class_id: number;
          created_at?: string;
          extra_data?: Json | null;
          grader_result_id: number;
          id?: number;
          is_released?: boolean;
          max_score?: number | null;
          name: string;
          name_format?: string;
          output?: string | null;
          output_format?: string | null;
          part?: string | null;
          score?: number | null;
          student_id?: string | null;
          submission_id?: number | null;
        };
        Update: {
          assignment_group_id?: number | null;
          class_id?: number;
          created_at?: string;
          extra_data?: Json | null;
          grader_result_id?: number;
          id?: number;
          is_released?: boolean;
          max_score?: number | null;
          name?: string;
          name_format?: string;
          output?: string | null;
          output_format?: string | null;
          part?: string | null;
          score?: number | null;
          student_id?: string | null;
          submission_id?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "grader_result_tests_assignment_group_id_fkey";
            columns: ["assignment_group_id"];
            isOneToOne: false;
            referencedRelation: "assignment_groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grader_result_tests_grader_result_id_fkey";
            columns: ["grader_result_id"];
            isOneToOne: false;
            referencedRelation: "grader_results";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grader_result_tests_student_id_fkey";
            columns: ["student_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grader_result_tests_student_id_fkey";
            columns: ["student_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "grader_result_tests_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grader_result_tests_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_agg";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grader_result_tests_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["activesubmissionid"];
          },
          {
            foreignKeyName: "grader_result_tests_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["activesubmissionid"];
          },
          {
            foreignKeyName: "grader_test_results_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          }
        ];
      };
      grader_results: {
        Row: {
          assignment_group_id: number | null;
          autograder_regression_test: number | null;
          class_id: number;
          created_at: string;
          errors: Json | null;
          execution_time: number | null;
          grader_action_sha: string | null;
          grader_sha: string | null;
          id: number;
          lint_output: string;
          lint_output_format: string;
          lint_passed: boolean;
          max_score: number;
          profile_id: string | null;
          ret_code: number | null;
          score: number;
          submission_id: number | null;
        };
        Insert: {
          assignment_group_id?: number | null;
          autograder_regression_test?: number | null;
          class_id: number;
          created_at?: string;
          errors?: Json | null;
          execution_time?: number | null;
          grader_action_sha?: string | null;
          grader_sha?: string | null;
          id?: number;
          lint_output: string;
          lint_output_format: string;
          lint_passed: boolean;
          max_score?: number;
          profile_id?: string | null;
          ret_code?: number | null;
          score: number;
          submission_id?: number | null;
        };
        Update: {
          assignment_group_id?: number | null;
          autograder_regression_test?: number | null;
          class_id?: number;
          created_at?: string;
          errors?: Json | null;
          execution_time?: number | null;
          grader_action_sha?: string | null;
          grader_sha?: string | null;
          id?: number;
          lint_output?: string;
          lint_output_format?: string;
          lint_passed?: boolean;
          max_score?: number;
          profile_id?: string | null;
          ret_code?: number | null;
          score?: number;
          submission_id?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "grader_results_assignment_group_id_fkey";
            columns: ["assignment_group_id"];
            isOneToOne: false;
            referencedRelation: "assignment_groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grader_results_autograder_regression_test_fkey";
            columns: ["autograder_regression_test"];
            isOneToOne: false;
            referencedRelation: "autograder_regression_test";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grader_results_autograder_regression_test_fkey";
            columns: ["autograder_regression_test"];
            isOneToOne: false;
            referencedRelation: "autograder_regression_test_by_grader";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grader_results_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grader_results_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: true;
            referencedRelation: "submissions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grader_results_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: true;
            referencedRelation: "submissions_agg";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grader_results_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: true;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["activesubmissionid"];
          },
          {
            foreignKeyName: "grader_results_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: true;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["activesubmissionid"];
          },
          {
            foreignKeyName: "grader_results_user_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grader_results_user_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          }
        ];
      };
      grading_conflicts: {
        Row: {
          class_id: number;
          created_at: string;
          created_by_profile_id: string;
          grader_profile_id: string;
          id: number;
          reason: string | null;
          student_profile_id: string;
        };
        Insert: {
          class_id: number;
          created_at?: string;
          created_by_profile_id: string;
          grader_profile_id: string;
          id?: number;
          reason?: string | null;
          student_profile_id: string;
        };
        Update: {
          class_id?: number;
          created_at?: string;
          created_by_profile_id?: string;
          grader_profile_id?: string;
          id?: number;
          reason?: string | null;
          student_profile_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "grading_conflicts_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grading_conflicts_created_by_profile_id_fkey";
            columns: ["created_by_profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grading_conflicts_created_by_profile_id_fkey";
            columns: ["created_by_profile_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "grading_conflicts_grader_profile_id_fkey";
            columns: ["grader_profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grading_conflicts_grader_profile_id_fkey";
            columns: ["grader_profile_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "grading_conflicts_student_profile_id_fkey";
            columns: ["student_profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grading_conflicts_student_profile_id_fkey";
            columns: ["student_profile_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          }
        ];
      };
      help_queues: {
        Row: {
          available: boolean;
          class_id: number;
          closing_at: string | null;
          color: string | null;
          created_at: string;
          depth: number;
          description: string;
          id: number;
          name: string;
        };
        Insert: {
          available?: boolean;
          class_id: number;
          closing_at?: string | null;
          color?: string | null;
          created_at?: string;
          depth: number;
          description: string;
          id?: number;
          name: string;
        };
        Update: {
          available?: boolean;
          class_id?: number;
          closing_at?: string | null;
          color?: string | null;
          created_at?: string;
          depth?: number;
          description?: string;
          id?: number;
          name?: string;
        };
        Relationships: [
          {
            foreignKeyName: "help_queues_class_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          }
        ];
      };
      help_request_messages: {
        Row: {
          author: string;
          class_id: number;
          created_at: string;
          help_request_id: number;
          id: number;
          instructors_only: boolean;
          message: string;
          requestor: string | null;
        };
        Insert: {
          author: string;
          class_id: number;
          created_at?: string;
          help_request_id: number;
          id?: number;
          instructors_only?: boolean;
          message: string;
          requestor?: string | null;
        };
        Update: {
          author?: string;
          class_id?: number;
          created_at?: string;
          help_request_id?: number;
          id?: number;
          instructors_only?: boolean;
          message?: string;
          requestor?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "help_request_messages_author_fkey1";
            columns: ["author"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "help_request_messages_author_fkey1";
            columns: ["author"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "help_request_messages_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "help_request_messages_help_request_id_fkey";
            columns: ["help_request_id"];
            isOneToOne: false;
            referencedRelation: "help_requests";
            referencedColumns: ["id"];
          }
        ];
      };
      help_requests: {
        Row: {
          assignee: string | null;
          class_id: number;
          created_at: string;
          creator: string;
          followup_to: number | null;
          help_queue: number;
          id: number;
          is_video_live: boolean;
          request: string;
          resolved_at: string | null;
          resolved_by: string | null;
        };
        Insert: {
          assignee?: string | null;
          class_id: number;
          created_at?: string;
          creator: string;
          followup_to?: number | null;
          help_queue: number;
          id?: number;
          is_video_live?: boolean;
          request: string;
          resolved_at?: string | null;
          resolved_by?: string | null;
        };
        Update: {
          assignee?: string | null;
          class_id?: number;
          created_at?: string;
          creator?: string;
          followup_to?: number | null;
          help_queue?: number;
          id?: number;
          is_video_live?: boolean;
          request?: string;
          resolved_at?: string | null;
          resolved_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "help_requests_assignee_fkey";
            columns: ["assignee"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "help_requests_assignee_fkey";
            columns: ["assignee"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "help_requests_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "help_requests_creator_fkey";
            columns: ["creator"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "help_requests_creator_fkey";
            columns: ["creator"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "help_requests_help_queue_fkey";
            columns: ["help_queue"];
            isOneToOne: false;
            referencedRelation: "help_queues";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "help_requests_resolved_by_fkey";
            columns: ["resolved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "help_requests_resolved_by_fkey";
            columns: ["resolved_by"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          }
        ];
      };
      name_generation_words: {
        Row: {
          id: number;
          is_adjective: boolean;
          is_noun: boolean;
          word: string;
        };
        Insert: {
          id?: number;
          is_adjective: boolean;
          is_noun: boolean;
          word: string;
        };
        Update: {
          id?: number;
          is_adjective?: boolean;
          is_noun?: boolean;
          word?: string;
        };
        Relationships: [];
      };
      notifications: {
        Row: {
          body: Json;
          class_id: number;
          created_at: string;
          id: number;
          style: string | null;
          subject: Json;
          user_id: string;
          viewed_at: string | null;
        };
        Insert: {
          body: Json;
          class_id: number;
          created_at?: string;
          id?: number;
          style?: string | null;
          subject: Json;
          user_id: string;
          viewed_at?: string | null;
        };
        Update: {
          body?: Json;
          class_id?: number;
          created_at?: string;
          id?: number;
          style?: string | null;
          subject?: Json;
          user_id?: string;
          viewed_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "notifications_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notifications_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["user_id"];
          }
        ];
      };
      permissions: {
        Row: {
          created_at: string;
          id: number;
          permission: string | null;
          user_id: string | null;
        };
        Insert: {
          created_at?: string;
          id?: number;
          permission?: string | null;
          user_id?: string | null;
        };
        Update: {
          created_at?: string;
          id?: number;
          permission?: string | null;
          user_id?: string | null;
        };
        Relationships: [];
      };
      poll_question_answers: {
        Row: {
          class_id: number;
          created_at: string;
          description: string | null;
          id: number;
          ordinal: number;
          poll: number;
          poll_question: number;
          title: string;
        };
        Insert: {
          class_id: number;
          created_at?: string;
          description?: string | null;
          id?: number;
          ordinal?: number;
          poll: number;
          poll_question: number;
          title: string;
        };
        Update: {
          class_id?: number;
          created_at?: string;
          description?: string | null;
          id?: number;
          ordinal?: number;
          poll?: number;
          poll_question?: number;
          title?: string;
        };
        Relationships: [
          {
            foreignKeyName: "poll_question_answers_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "poll_question_answers_poll_fkey";
            columns: ["poll"];
            isOneToOne: false;
            referencedRelation: "polls";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "poll_question_answers_poll_question_fkey";
            columns: ["poll_question"];
            isOneToOne: false;
            referencedRelation: "poll_questions";
            referencedColumns: ["id"];
          }
        ];
      };
      poll_question_results: {
        Row: {
          count: number;
          created_at: string;
          id: number;
          poll: number;
          poll_question: number;
          poll_question_answer: number;
        };
        Insert: {
          count?: number;
          created_at?: string;
          id?: number;
          poll: number;
          poll_question: number;
          poll_question_answer: number;
        };
        Update: {
          count?: number;
          created_at?: string;
          id?: number;
          poll?: number;
          poll_question?: number;
          poll_question_answer?: number;
        };
        Relationships: [
          {
            foreignKeyName: "poll_question_results_poll_fkey";
            columns: ["poll"];
            isOneToOne: false;
            referencedRelation: "polls";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "poll_question_results_poll_question_answer_fkey";
            columns: ["poll_question_answer"];
            isOneToOne: false;
            referencedRelation: "poll_question_answers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "poll_question_results_poll_question_fkey";
            columns: ["poll_question"];
            isOneToOne: false;
            referencedRelation: "poll_questions";
            referencedColumns: ["id"];
          }
        ];
      };
      poll_questions: {
        Row: {
          class_id: number;
          created_at: string;
          description: string | null;
          id: number;
          poll: number;
          question_type: string;
          title: string;
        };
        Insert: {
          class_id: number;
          created_at?: string;
          description?: string | null;
          id?: number;
          poll: number;
          question_type?: string;
          title: string;
        };
        Update: {
          class_id?: number;
          created_at?: string;
          description?: string | null;
          id?: number;
          poll?: number;
          question_type?: string;
          title?: string;
        };
        Relationships: [
          {
            foreignKeyName: "poll_questions_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "poll_questions_poll_fkey";
            columns: ["poll"];
            isOneToOne: false;
            referencedRelation: "polls";
            referencedColumns: ["id"];
          }
        ];
      };
      poll_response_answers: {
        Row: {
          created_at: string;
          id: number;
          poll: number;
          poll_question: number;
          poll_question_answer: number;
          poll_response: number;
          profile_id: string;
        };
        Insert: {
          created_at?: string;
          id?: number;
          poll: number;
          poll_question: number;
          poll_question_answer: number;
          poll_response: number;
          profile_id?: string;
        };
        Update: {
          created_at?: string;
          id?: number;
          poll?: number;
          poll_question?: number;
          poll_question_answer?: number;
          poll_response?: number;
          profile_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "poll_response_answers_poll_fkey";
            columns: ["poll"];
            isOneToOne: false;
            referencedRelation: "polls";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "poll_response_answers_poll_question_answer_fkey";
            columns: ["poll_question_answer"];
            isOneToOne: false;
            referencedRelation: "poll_question_answers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "poll_response_answers_poll_question_fkey";
            columns: ["poll_question"];
            isOneToOne: false;
            referencedRelation: "poll_questions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "poll_response_answers_poll_response_fkey";
            columns: ["poll_response"];
            isOneToOne: false;
            referencedRelation: "poll_responses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "poll_response_answers_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "poll_response_answers_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          }
        ];
      };
      poll_responses: {
        Row: {
          class_id: number;
          created_at: string;
          ended_at: string | null;
          id: number;
          poll: number;
          profile_id: string;
        };
        Insert: {
          class_id: number;
          created_at?: string;
          ended_at?: string | null;
          id?: number;
          poll: number;
          profile_id: string;
        };
        Update: {
          class_id?: number;
          created_at?: string;
          ended_at?: string | null;
          id?: number;
          poll?: number;
          profile_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "poll_responses_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "poll_responses_poll_fkey";
            columns: ["poll"];
            isOneToOne: false;
            referencedRelation: "polls";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "poll_responses_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "poll_responses_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          }
        ];
      };
      polls: {
        Row: {
          class_id: number;
          created_at: string;
          description: string | null;
          due_date: string | null;
          flair: Json | null;
          id: number;
          name: string;
          released_at: string | null;
        };
        Insert: {
          class_id: number;
          created_at?: string;
          description?: string | null;
          due_date?: string | null;
          flair?: Json | null;
          id?: number;
          name: string;
          released_at?: string | null;
        };
        Update: {
          class_id?: number;
          created_at?: string;
          description?: string | null;
          due_date?: string | null;
          flair?: Json | null;
          id?: number;
          name?: string;
          released_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "polls_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          }
        ];
      };
      profiles: {
        Row: {
          avatar_url: string | null;
          class_id: number;
          created_at: string;
          flair: string | null;
          flair_color: string | null;
          id: string;
          is_private_profile: boolean;
          name: string | null;
          short_name: string | null;
          sis_user_id: string | null;
          sortable_name: string | null;
          time_zone: string | null;
        };
        Insert: {
          avatar_url?: string | null;
          class_id: number;
          created_at?: string;
          flair?: string | null;
          flair_color?: string | null;
          id?: string;
          is_private_profile: boolean;
          name?: string | null;
          short_name?: string | null;
          sis_user_id?: string | null;
          sortable_name?: string | null;
          time_zone?: string | null;
        };
        Update: {
          avatar_url?: string | null;
          class_id?: number;
          created_at?: string;
          flair?: string | null;
          flair_color?: string | null;
          id?: string;
          is_private_profile?: boolean;
          name?: string | null;
          short_name?: string | null;
          sis_user_id?: string | null;
          sortable_name?: string | null;
          time_zone?: string | null;
        };
        Relationships: [];
      };
      repositories: {
        Row: {
          assignment_group_id: number | null;
          assignment_id: number;
          class_id: number;
          created_at: string;
          id: number;
          profile_id: string | null;
          repository: string;
          synced_handout_sha: string | null;
          synced_repo_sha: string | null;
        };
        Insert: {
          assignment_group_id?: number | null;
          assignment_id: number;
          class_id: number;
          created_at?: string;
          id?: number;
          profile_id?: string | null;
          repository: string;
          synced_handout_sha?: string | null;
          synced_repo_sha?: string | null;
        };
        Update: {
          assignment_group_id?: number | null;
          assignment_id?: number;
          class_id?: number;
          created_at?: string;
          id?: number;
          profile_id?: string | null;
          repository?: string;
          synced_handout_sha?: string | null;
          synced_repo_sha?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "repositories_assignment_group_id_fkey";
            columns: ["assignment_group_id"];
            isOneToOne: false;
            referencedRelation: "assignment_groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "repositories_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "assignments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "repositories_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "repositories_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "repositories_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "repositories_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "submissions_agg";
            referencedColumns: ["profile_id"];
          },
          {
            foreignKeyName: "repositories_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "user_roles";
            referencedColumns: ["private_profile_id"];
          },
          {
            foreignKeyName: "repositories_user_id_fkey1";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "repositories_user_id_fkey1";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          }
        ];
      };
      repository_check_runs: {
        Row: {
          assignment_group_id: number | null;
          check_run_id: number;
          class_id: number;
          commit_message: string;
          created_at: string;
          id: number;
          profile_id: string | null;
          repository_id: number;
          sha: string;
          status: Json;
          triggered_by: string | null;
        };
        Insert: {
          assignment_group_id?: number | null;
          check_run_id: number;
          class_id: number;
          commit_message: string;
          created_at?: string;
          id?: number;
          profile_id?: string | null;
          repository_id: number;
          sha: string;
          status: Json;
          triggered_by?: string | null;
        };
        Update: {
          assignment_group_id?: number | null;
          check_run_id?: number;
          class_id?: number;
          commit_message?: string;
          created_at?: string;
          id?: number;
          profile_id?: string | null;
          repository_id?: number;
          sha?: string;
          status?: Json;
          triggered_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "repository_check_run_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "repository_check_run_repository_id_fkey";
            columns: ["repository_id"];
            isOneToOne: false;
            referencedRelation: "repositories";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "repository_check_runs_assignment_group_id_fkey";
            columns: ["assignment_group_id"];
            isOneToOne: false;
            referencedRelation: "assignment_groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "repository_check_runs_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "repository_check_runs_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "repository_check_runs_triggered_by_fkey";
            columns: ["triggered_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "repository_check_runs_triggered_by_fkey";
            columns: ["triggered_by"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "repository_check_runs_triggered_by_fkey1";
            columns: ["triggered_by"];
            isOneToOne: false;
            referencedRelation: "submissions_agg";
            referencedColumns: ["profile_id"];
          },
          {
            foreignKeyName: "repository_check_runs_triggered_by_fkey1";
            columns: ["triggered_by"];
            isOneToOne: false;
            referencedRelation: "user_roles";
            referencedColumns: ["private_profile_id"];
          }
        ];
      };
      review_assignment_rubric_parts: {
        Row: {
          class_id: number;
          created_at: string;
          id: number;
          review_assignment_id: number;
          rubric_part_id: number;
        };
        Insert: {
          class_id: number;
          created_at?: string;
          id?: number;
          review_assignment_id: number;
          rubric_part_id: number;
        };
        Update: {
          class_id?: number;
          created_at?: string;
          id?: number;
          review_assignment_id?: number;
          rubric_part_id?: number;
        };
        Relationships: [
          {
            foreignKeyName: "review_assignment_rubric_parts_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "review_assignment_rubric_parts_review_assignment_id_fkey";
            columns: ["review_assignment_id"];
            isOneToOne: false;
            referencedRelation: "review_assignments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "review_assignment_rubric_parts_rubric_part_id_fkey";
            columns: ["rubric_part_id"];
            isOneToOne: false;
            referencedRelation: "rubric_parts";
            referencedColumns: ["id"];
          }
        ];
      };
      review_assignments: {
        Row: {
          assignee_profile_id: string;
          assignment_id: number;
          class_id: number;
          created_at: string;
          due_date: string;
          id: number;
          max_allowable_late_tokens: number;
          release_date: string | null;
          rubric_id: number;
          submission_id: number;
          submission_review_id: number;
        };
        Insert: {
          assignee_profile_id: string;
          assignment_id: number;
          class_id: number;
          created_at?: string;
          due_date: string;
          id?: number;
          max_allowable_late_tokens?: number;
          release_date?: string | null;
          rubric_id: number;
          submission_id: number;
          submission_review_id: number;
        };
        Update: {
          assignee_profile_id?: string;
          assignment_id?: number;
          class_id?: number;
          created_at?: string;
          due_date?: string;
          id?: number;
          max_allowable_late_tokens?: number;
          release_date?: string | null;
          rubric_id?: number;
          submission_id?: number;
          submission_review_id?: number;
        };
        Relationships: [
          {
            foreignKeyName: "review_assignments_assignee_profile_id_fkey";
            columns: ["assignee_profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "review_assignments_assignee_profile_id_fkey";
            columns: ["assignee_profile_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "review_assignments_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "assignments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "review_assignments_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "review_assignments_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "review_assignments_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "review_assignments_rubric_id_fkey";
            columns: ["rubric_id"];
            isOneToOne: false;
            referencedRelation: "rubrics";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "review_assignments_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "review_assignments_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_agg";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "review_assignments_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["activesubmissionid"];
          },
          {
            foreignKeyName: "review_assignments_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["activesubmissionid"];
          },
          {
            foreignKeyName: "review_assignments_submission_review_id_fkey";
            columns: ["submission_review_id"];
            isOneToOne: false;
            referencedRelation: "submission_reviews";
            referencedColumns: ["id"];
          }
        ];
      };
      rubric_check_references: {
        Row: {
          class_id: number;
          created_at: string;
          id: number;
          referenced_rubric_check_id: number;
          referencing_rubric_check_id: number;
        };
        Insert: {
          class_id: number;
          created_at?: string;
          id?: number;
          referenced_rubric_check_id: number;
          referencing_rubric_check_id: number;
        };
        Update: {
          class_id?: number;
          created_at?: string;
          id?: number;
          referenced_rubric_check_id?: number;
          referencing_rubric_check_id?: number;
        };
        Relationships: [
          {
            foreignKeyName: "rubric_check_references_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "rubric_check_references_referenced_rubric_check_id_fkey";
            columns: ["referenced_rubric_check_id"];
            isOneToOne: false;
            referencedRelation: "rubric_checks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "rubric_check_references_referencing_rubric_check_id_fkey";
            columns: ["referencing_rubric_check_id"];
            isOneToOne: false;
            referencedRelation: "rubric_checks";
            referencedColumns: ["id"];
          }
        ];
      };
      rubric_checks: {
        Row: {
          annotation_target: string | null;
          artifact: string | null;
          class_id: number;
          created_at: string;
          data: Json | null;
          description: string | null;
          file: string | null;
          group: string | null;
          id: number;
          is_annotation: boolean;
          is_comment_required: boolean;
          is_required: boolean;
          max_annotations: number | null;
          name: string;
          ordinal: number;
          points: number;
          rubric_criteria_id: number;
        };
        Insert: {
          annotation_target?: string | null;
          artifact?: string | null;
          class_id: number;
          created_at?: string;
          data?: Json | null;
          description?: string | null;
          file?: string | null;
          group?: string | null;
          id?: number;
          is_annotation: boolean;
          is_comment_required?: boolean;
          is_required?: boolean;
          max_annotations?: number | null;
          name: string;
          ordinal: number;
          points: number;
          rubric_criteria_id: number;
        };
        Update: {
          annotation_target?: string | null;
          artifact?: string | null;
          class_id?: number;
          created_at?: string;
          data?: Json | null;
          description?: string | null;
          file?: string | null;
          group?: string | null;
          id?: number;
          is_annotation?: boolean;
          is_comment_required?: boolean;
          is_required?: boolean;
          max_annotations?: number | null;
          name?: string;
          ordinal?: number;
          points?: number;
          rubric_criteria_id?: number;
        };
        Relationships: [
          {
            foreignKeyName: "rubric_checks_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "rubric_checks_rubric_criteria_id_fkey";
            columns: ["rubric_criteria_id"];
            isOneToOne: false;
            referencedRelation: "rubric_criteria";
            referencedColumns: ["id"];
          }
        ];
      };
      rubric_criteria: {
        Row: {
          class_id: number;
          created_at: string;
          data: Json | null;
          description: string | null;
          id: number;
          is_additive: boolean;
          max_checks_per_submission: number | null;
          min_checks_per_submission: number | null;
          name: string;
          ordinal: number;
          rubric_id: number;
          rubric_part_id: number;
          total_points: number;
        };
        Insert: {
          class_id: number;
          created_at?: string;
          data?: Json | null;
          description?: string | null;
          id?: number;
          is_additive: boolean;
          max_checks_per_submission?: number | null;
          min_checks_per_submission?: number | null;
          name: string;
          ordinal?: number;
          rubric_id: number;
          rubric_part_id: number;
          total_points: number;
        };
        Update: {
          class_id?: number;
          created_at?: string;
          data?: Json | null;
          description?: string | null;
          id?: number;
          is_additive?: boolean;
          max_checks_per_submission?: number | null;
          min_checks_per_submission?: number | null;
          name?: string;
          ordinal?: number;
          rubric_id?: number;
          rubric_part_id?: number;
          total_points?: number;
        };
        Relationships: [
          {
            foreignKeyName: "rubric_criteria_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "rubric_criteria_rubric_id_fkey";
            columns: ["rubric_id"];
            isOneToOne: false;
            referencedRelation: "rubrics";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "rubric_criteria_rubric_part_id_fkey";
            columns: ["rubric_part_id"];
            isOneToOne: false;
            referencedRelation: "rubric_parts";
            referencedColumns: ["id"];
          }
        ];
      };
      rubric_parts: {
        Row: {
          class_id: number;
          created_at: string;
          data: Json | null;
          description: string | null;
          id: number;
          name: string;
          ordinal: number;
          rubric_id: number;
        };
        Insert: {
          class_id: number;
          created_at?: string;
          data?: Json | null;
          description?: string | null;
          id?: number;
          name: string;
          ordinal: number;
          rubric_id: number;
        };
        Update: {
          class_id?: number;
          created_at?: string;
          data?: Json | null;
          description?: string | null;
          id?: number;
          name?: string;
          ordinal?: number;
          rubric_id?: number;
        };
        Relationships: [
          {
            foreignKeyName: "rubric_parts_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "rubric_parts_rubric_id_fkey";
            columns: ["rubric_id"];
            isOneToOne: false;
            referencedRelation: "rubrics";
            referencedColumns: ["id"];
          }
        ];
      };
      rubrics: {
        Row: {
          assignment_id: number;
          class_id: number;
          created_at: string;
          description: string | null;
          id: number;
          is_private: boolean;
          name: string;
          review_round: Database["public"]["Enums"]["review_round"] | null;
        };
        Insert: {
          assignment_id: number;
          class_id: number;
          created_at?: string;
          description?: string | null;
          id?: number;
          is_private?: boolean;
          name: string;
          review_round?: Database["public"]["Enums"]["review_round"] | null;
        };
        Update: {
          assignment_id?: number;
          class_id?: number;
          created_at?: string;
          description?: string | null;
          id?: number;
          is_private?: boolean;
          name?: string;
          review_round?: Database["public"]["Enums"]["review_round"] | null;
        };
        Relationships: [
          {
            foreignKeyName: "assignment_rubric_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "rubrics_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "assignments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "rubrics_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "rubrics_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["assignment_id"];
          }
        ];
      };
      assignment_self_review_settings: {
        Row: {
          allow_early: boolean | null;
          class_id: number;
          deadline_offset: number | null;
          enabled: boolean;
          id: number;
        };
        Insert: {
          allow_early?: boolean | null;
          class_id: number;
          deadline_offset?: number | null;
          enabled?: boolean;
          id?: number;
        };
        Update: {
          allow_early?: boolean | null;
          class_id?: number;
          deadline_offset?: number | null;
          enabled?: boolean;
          id?: number;
        };
        Relationships: [
          {
            foreignKeyName: "self_review_settings_class_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          }
        ];
      };
      submission_artifact_comments: {
        Row: {
          author: string;
          class_id: number;
          comment: string;
          created_at: string;
          deleted_at: string | null;
          edited_at: string | null;
          edited_by: string | null;
          eventually_visible: boolean;
          id: number;
          points: number | null;
          released: boolean;
          rubric_check_id: number | null;
          submission_artifact_id: number;
          submission_id: number;
          submission_review_id: number | null;
        };
        Insert: {
          author: string;
          class_id: number;
          comment: string;
          created_at?: string;
          deleted_at?: string | null;
          edited_at?: string | null;
          edited_by?: string | null;
          eventually_visible?: boolean;
          id?: number;
          points?: number | null;
          released?: boolean;
          rubric_check_id?: number | null;
          submission_artifact_id: number;
          submission_id: number;
          submission_review_id?: number | null;
        };
        Update: {
          author?: string;
          class_id?: number;
          comment?: string;
          created_at?: string;
          deleted_at?: string | null;
          edited_at?: string | null;
          edited_by?: string | null;
          eventually_visible?: boolean;
          id?: number;
          points?: number | null;
          released?: boolean;
          rubric_check_id?: number | null;
          submission_artifact_id?: number;
          submission_id?: number;
          submission_review_id?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "submission_artifact_comments_author_fkey";
            columns: ["author"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_artifact_comments_author_fkey";
            columns: ["author"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "submission_artifact_comments_author_fkey1";
            columns: ["author"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_artifact_comments_author_fkey1";
            columns: ["author"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "submission_artifact_comments_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_artifact_comments_class_id_fkey1";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_artifact_comments_rubric_check_id_fkey";
            columns: ["rubric_check_id"];
            isOneToOne: false;
            referencedRelation: "rubric_checks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_artifact_comments_rubric_check_id_fkey1";
            columns: ["rubric_check_id"];
            isOneToOne: false;
            referencedRelation: "rubric_checks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_artifact_id_fkey";
            columns: ["submission_artifact_id"];
            isOneToOne: false;
            referencedRelation: "submission_artifacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_agg";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["activesubmissionid"];
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["activesubmissionid"];
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_id_fkey1";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_id_fkey1";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_agg";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_id_fkey1";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["activesubmissionid"];
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_id_fkey1";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["activesubmissionid"];
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_review_id_fkey";
            columns: ["submission_review_id"];
            isOneToOne: false;
            referencedRelation: "submission_reviews";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_artifact_comments_submission_review_id_fkey1";
            columns: ["submission_review_id"];
            isOneToOne: false;
            referencedRelation: "submission_reviews";
            referencedColumns: ["id"];
          }
        ];
      };
      submission_artifacts: {
        Row: {
          assignment_group_id: number | null;
          autograder_regression_test_id: number | null;
          class_id: number;
          created_at: string;
          data: Json | null;
          id: number;
          name: string;
          profile_id: string | null;
          submission_file_id: number | null;
          submission_id: number;
        };
        Insert: {
          assignment_group_id?: number | null;
          autograder_regression_test_id?: number | null;
          class_id: number;
          created_at?: string;
          data?: Json | null;
          id?: number;
          name: string;
          profile_id?: string | null;
          submission_file_id?: number | null;
          submission_id: number;
        };
        Update: {
          assignment_group_id?: number | null;
          autograder_regression_test_id?: number | null;
          class_id?: number;
          created_at?: string;
          data?: Json | null;
          id?: number;
          name?: string;
          profile_id?: string | null;
          submission_file_id?: number | null;
          submission_id?: number;
        };
        Relationships: [
          {
            foreignKeyName: "submission_artifacts_assignment_group_id_fkey";
            columns: ["assignment_group_id"];
            isOneToOne: false;
            referencedRelation: "assignment_groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_artifacts_autograder_regression_test_id_fkey";
            columns: ["autograder_regression_test_id"];
            isOneToOne: false;
            referencedRelation: "autograder_regression_test";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_artifacts_autograder_regression_test_id_fkey";
            columns: ["autograder_regression_test_id"];
            isOneToOne: false;
            referencedRelation: "autograder_regression_test_by_grader";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_artifacts_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_artifacts_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_artifacts_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "submission_artifacts_submission_file_id_fkey";
            columns: ["submission_file_id"];
            isOneToOne: false;
            referencedRelation: "submission_files";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_artifacts_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_artifacts_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_agg";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_artifacts_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["activesubmissionid"];
          },
          {
            foreignKeyName: "submission_artifacts_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["activesubmissionid"];
          }
        ];
      };
      submission_comments: {
        Row: {
          author: string;
          class_id: number;
          comment: string;
          created_at: string;
          deleted_at: string | null;
          edited_at: string | null;
          edited_by: string | null;
          eventually_visible: boolean;
          id: number;
          points: number | null;
          released: boolean;
          rubric_check_id: number | null;
          submission_id: number;
          submission_review_id: number | null;
        };
        Insert: {
          author: string;
          class_id: number;
          comment: string;
          created_at?: string;
          deleted_at?: string | null;
          edited_at?: string | null;
          edited_by?: string | null;
          eventually_visible?: boolean;
          id?: number;
          points?: number | null;
          released?: boolean;
          rubric_check_id?: number | null;
          submission_id: number;
          submission_review_id?: number | null;
        };
        Update: {
          author?: string;
          class_id?: number;
          comment?: string;
          created_at?: string;
          deleted_at?: string | null;
          edited_at?: string | null;
          edited_by?: string | null;
          eventually_visible?: boolean;
          id?: number;
          points?: number | null;
          released?: boolean;
          rubric_check_id?: number | null;
          submission_id?: number;
          submission_review_id?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "submission_comments_author_fkey";
            columns: ["author"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_comments_author_fkey";
            columns: ["author"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "submission_comments_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_comments_rubric_check_id_fkey";
            columns: ["rubric_check_id"];
            isOneToOne: false;
            referencedRelation: "rubric_checks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_comments_submission_review_id_fkey";
            columns: ["submission_review_id"];
            isOneToOne: false;
            referencedRelation: "submission_reviews";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_comments_submissions_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_comments_submissions_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_agg";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_comments_submissions_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["activesubmissionid"];
          },
          {
            foreignKeyName: "submission_comments_submissions_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["activesubmissionid"];
          }
        ];
      };
      submission_file_comments: {
        Row: {
          author: string;
          class_id: number;
          comment: string;
          created_at: string;
          deleted_at: string | null;
          edited_at: string | null;
          edited_by: string | null;
          eventually_visible: boolean;
          id: number;
          line: number;
          points: number | null;
          released: boolean;
          rubric_check_id: number | null;
          submission_file_id: number;
          submission_id: number;
          submission_review_id: number | null;
        };
        Insert: {
          author: string;
          class_id: number;
          comment: string;
          created_at?: string;
          deleted_at?: string | null;
          edited_at?: string | null;
          edited_by?: string | null;
          eventually_visible?: boolean;
          id?: number;
          line: number;
          points?: number | null;
          released?: boolean;
          rubric_check_id?: number | null;
          submission_file_id: number;
          submission_id: number;
          submission_review_id?: number | null;
        };
        Update: {
          author?: string;
          class_id?: number;
          comment?: string;
          created_at?: string;
          deleted_at?: string | null;
          edited_at?: string | null;
          edited_by?: string | null;
          eventually_visible?: boolean;
          id?: number;
          line?: number;
          points?: number | null;
          released?: boolean;
          rubric_check_id?: number | null;
          submission_file_id?: number;
          submission_id?: number;
          submission_review_id?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "submission_file_comments_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_file_comments_rubric_check_id_fkey";
            columns: ["rubric_check_id"];
            isOneToOne: false;
            referencedRelation: "rubric_checks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_file_comments_submission_review_id_fkey";
            columns: ["submission_review_id"];
            isOneToOne: false;
            referencedRelation: "submission_reviews";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_file_lcomments_author_fkey";
            columns: ["author"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_file_lcomments_author_fkey";
            columns: ["author"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "submission_file_lcomments_submission_files_id_fkey";
            columns: ["submission_file_id"];
            isOneToOne: false;
            referencedRelation: "submission_files";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_file_lcomments_submissions_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_file_lcomments_submissions_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_agg";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_file_lcomments_submissions_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["activesubmissionid"];
          },
          {
            foreignKeyName: "submission_file_lcomments_submissions_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["activesubmissionid"];
          }
        ];
      };
      submission_files: {
        Row: {
          assignment_group_id: number | null;
          class_id: number;
          contents: string;
          created_at: string;
          id: number;
          name: string;
          profile_id: string | null;
          submission_id: number;
        };
        Insert: {
          assignment_group_id?: number | null;
          class_id: number;
          contents: string;
          created_at?: string;
          id?: number;
          name: string;
          profile_id?: string | null;
          submission_id: number;
        };
        Update: {
          assignment_group_id?: number | null;
          class_id?: number;
          contents?: string;
          created_at?: string;
          id?: number;
          name?: string;
          profile_id?: string | null;
          submission_id?: number;
        };
        Relationships: [
          {
            foreignKeyName: "submission_files_assignment_group_id_fkey";
            columns: ["assignment_group_id"];
            isOneToOne: false;
            referencedRelation: "assignment_groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_files_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_files_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "submissions_agg";
            referencedColumns: ["profile_id"];
          },
          {
            foreignKeyName: "submission_files_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "user_roles";
            referencedColumns: ["private_profile_id"];
          },
          {
            foreignKeyName: "submission_files_submissions_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_files_submissions_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_agg";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_files_submissions_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["activesubmissionid"];
          },
          {
            foreignKeyName: "submission_files_submissions_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["activesubmissionid"];
          },
          {
            foreignKeyName: "submission_files_user_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_files_user_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          }
        ];
      };
      submission_reviews: {
        Row: {
          checked_at: string | null;
          checked_by: string | null;
          class_id: number;
          completed_at: string | null;
          completed_by: string | null;
          created_at: string;
          grader: string | null;
          id: number;
          meta_grader: string | null;
          name: string;
          released: boolean;
          rubric_id: number;
          submission_id: number;
          total_autograde_score: number;
          total_score: number;
          tweak: number;
        };
        Insert: {
          checked_at?: string | null;
          checked_by?: string | null;
          class_id: number;
          completed_at?: string | null;
          completed_by?: string | null;
          created_at?: string;
          grader?: string | null;
          id?: number;
          meta_grader?: string | null;
          name: string;
          released?: boolean;
          rubric_id: number;
          submission_id: number;
          total_autograde_score?: number;
          total_score: number;
          tweak: number;
        };
        Update: {
          checked_at?: string | null;
          checked_by?: string | null;
          class_id?: number;
          completed_at?: string | null;
          completed_by?: string | null;
          created_at?: string;
          grader?: string | null;
          id?: number;
          meta_grader?: string | null;
          name?: string;
          released?: boolean;
          rubric_id?: number;
          submission_id?: number;
          total_autograde_score?: number;
          total_score?: number;
          tweak?: number;
        };
        Relationships: [
          {
            foreignKeyName: "submission_reviews_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_reviews_completed_by_fkey";
            columns: ["completed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_reviews_completed_by_fkey";
            columns: ["completed_by"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "submission_reviews_grader_fkey";
            columns: ["grader"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_reviews_grader_fkey";
            columns: ["grader"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "submission_reviews_meta_grader_fkey";
            columns: ["meta_grader"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_reviews_meta_grader_fkey";
            columns: ["meta_grader"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "submission_reviews_rubric_id_fkey";
            columns: ["rubric_id"];
            isOneToOne: false;
            referencedRelation: "rubrics";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_reviews_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_reviews_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_agg";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_reviews_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["activesubmissionid"];
          },
          {
            foreignKeyName: "submission_reviews_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["activesubmissionid"];
          }
        ];
      };
      submissions: {
        Row: {
          assignment_group_id: number | null;
          assignment_id: number;
          class_id: number;
          created_at: string;
          grading_review_id: number | null;
          id: number;
          is_active: boolean;
          ordinal: number;
          profile_id: string | null;
          released: string | null;
          repository: string;
          repository_check_run_id: number | null;
          repository_id: number | null;
          run_attempt: number;
          run_number: number;
          sha: string;
        };
        Insert: {
          assignment_group_id?: number | null;
          assignment_id: number;
          class_id: number;
          created_at?: string;
          grading_review_id?: number | null;
          id?: number;
          is_active?: boolean;
          ordinal?: number;
          profile_id?: string | null;
          released?: string | null;
          repository: string;
          repository_check_run_id?: number | null;
          repository_id?: number | null;
          run_attempt: number;
          run_number: number;
          sha: string;
        };
        Update: {
          assignment_group_id?: number | null;
          assignment_id?: number;
          class_id?: number;
          created_at?: string;
          grading_review_id?: number | null;
          id?: number;
          is_active?: boolean;
          ordinal?: number;
          profile_id?: string | null;
          released?: string | null;
          repository?: string;
          repository_check_run_id?: number | null;
          repository_id?: number | null;
          run_attempt?: number;
          run_number?: number;
          sha?: string;
        };
        Relationships: [
          {
            foreignKeyName: "submissio_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "assignments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submissio_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "submissio_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "submissio_user_id_fkey1";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submissio_user_id_fkey1";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "submissions_assignment_group_id_fkey";
            columns: ["assignment_group_id"];
            isOneToOne: false;
            referencedRelation: "assignment_groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submissions_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submissions_grading_review_id_fkey";
            columns: ["grading_review_id"];
            isOneToOne: false;
            referencedRelation: "submission_reviews";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submissions_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "submissions_agg";
            referencedColumns: ["profile_id"];
          },
          {
            foreignKeyName: "submissions_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "user_roles";
            referencedColumns: ["private_profile_id"];
          },
          {
            foreignKeyName: "submissions_repository_check_run_id_fkey";
            columns: ["repository_check_run_id"];
            isOneToOne: false;
            referencedRelation: "repository_check_runs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submissions_repository_id_fkey";
            columns: ["repository_id"];
            isOneToOne: false;
            referencedRelation: "repositories";
            referencedColumns: ["id"];
          }
        ];
      };
      user_roles: {
        Row: {
          canvas_id: number | null;
          class_id: number;
          class_section_id: number | null;
          id: number;
          private_profile_id: string;
          public_profile_id: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          canvas_id?: number | null;
          class_id: number;
          class_section_id?: number | null;
          id?: number;
          private_profile_id: string;
          public_profile_id: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          canvas_id?: number | null;
          class_id?: number;
          class_section_id?: number | null;
          id?: number;
          private_profile_id?: string;
          public_profile_id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_roles_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_roles_class_section_id_fkey";
            columns: ["class_section_id"];
            isOneToOne: false;
            referencedRelation: "class_sections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_roles_private_profile_id_fkey";
            columns: ["private_profile_id"];
            isOneToOne: true;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_roles_private_profile_id_fkey";
            columns: ["private_profile_id"];
            isOneToOne: true;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "user_roles_public_profile_id_fkey";
            columns: ["public_profile_id"];
            isOneToOne: true;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_roles_public_profile_id_fkey";
            columns: ["public_profile_id"];
            isOneToOne: true;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "user_roles_user_id_fkey1";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["user_id"];
          }
        ];
      };
      users: {
        Row: {
          avatar_url: string | null;
          created_at: string;
          email: string | null;
          github_username: string | null;
          name: string | null;
          user_id: string;
        };
        Insert: {
          avatar_url?: string | null;
          created_at?: string;
          email?: string | null;
          github_username?: string | null;
          name?: string | null;
          user_id?: string;
        };
        Update: {
          avatar_url?: string | null;
          created_at?: string;
          email?: string | null;
          github_username?: string | null;
          name?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      video_meeting_sessions: {
        Row: {
          chime_meeting_id: string | null;
          class_id: number;
          created_at: string;
          ended: string | null;
          help_request_id: number;
          id: number;
          started: string | null;
        };
        Insert: {
          chime_meeting_id?: string | null;
          class_id: number;
          created_at?: string;
          ended?: string | null;
          help_request_id: number;
          id?: number;
          started?: string | null;
        };
        Update: {
          chime_meeting_id?: string | null;
          class_id?: number;
          created_at?: string;
          ended?: string | null;
          help_request_id?: number;
          id?: number;
          started?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "video_meeting_sessions_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "video_meeting_sessions_help_request_id_fkey";
            columns: ["help_request_id"];
            isOneToOne: false;
            referencedRelation: "help_requests";
            referencedColumns: ["id"];
          }
        ];
      };
      webhook_process_status: {
        Row: {
          completed: boolean;
          created_at: string;
          id: number;
          webhook_id: string;
        };
        Insert: {
          completed: boolean;
          created_at?: string;
          id?: number;
          webhook_id: string;
        };
        Update: {
          completed?: boolean;
          created_at?: string;
          id?: number;
          webhook_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      autograder_regression_test_by_grader: {
        Row: {
          class_id: number | null;
          grader_repo: string | null;
          id: number | null;
          name: string | null;
          repository: string | null;
          score: number | null;
          sha: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "grader_results_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          }
        ];
      };
      submissions_agg: {
        Row: {
          assignment_id: number | null;
          avatar_url: string | null;
          created_at: string | null;
          execution_time: number | null;
          groupname: string | null;
          id: number | null;
          latestsubmissionid: number | null;
          name: string | null;
          profile_id: string | null;
          released: string | null;
          repository: string | null;
          ret_code: number | null;
          run_attempt: number | null;
          run_number: number | null;
          score: number | null;
          sha: string | null;
          sortable_name: string | null;
          submissioncount: number | null;
          user_id: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "submissio_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "assignments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submissio_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "submissio_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment_and_regression_test";
            referencedColumns: ["assignment_id"];
          },
          {
            foreignKeyName: "submissio_user_id_fkey1";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submissio_user_id_fkey1";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "submissions_profile_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "submissions_agg";
            referencedColumns: ["profile_id"];
          },
          {
            foreignKeyName: "submissions_profile_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "user_roles";
            referencedColumns: ["private_profile_id"];
          },
          {
            foreignKeyName: "user_roles_private_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: true;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_roles_private_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: true;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          }
        ];
      };
      submissions_with_grades_for_assignment: {
        Row: {
          activesubmissionid: number | null;
          assignedgradername: string | null;
          assignedmetagradername: string | null;
          assignment_id: number | null;
          autograder_score: number | null;
          checked_at: string | null;
          checked_by: string | null;
          checkername: string | null;
          class_id: number | null;
          completed_at: string | null;
          completed_by: string | null;
          created_at: string | null;
          due_date: string | null;
          grader: string | null;
          grader_action_sha: string | null;
          grader_sha: string | null;
          gradername: string | null;
          groupname: string | null;
          hours: number | null;
          id: number | null;
          late_due_date: string | null;
          meta_grader: string | null;
          name: string | null;
          released: string | null;
          repository: string | null;
          sha: string | null;
          sortable_name: string | null;
          student_private_profile_id: string | null;
          tokens_consumed: number | null;
          total_score: number | null;
          tweak: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "submission_reviews_completed_by_fkey";
            columns: ["completed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_reviews_completed_by_fkey";
            columns: ["completed_by"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "submission_reviews_grader_fkey";
            columns: ["grader"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_reviews_grader_fkey";
            columns: ["grader"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "submission_reviews_meta_grader_fkey";
            columns: ["meta_grader"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "submission_reviews_meta_grader_fkey";
            columns: ["meta_grader"];
            isOneToOne: false;
            referencedRelation: "submissions_with_grades_for_assignment";
            referencedColumns: ["student_private_profile_id"];
          },
          {
            foreignKeyName: "user_roles_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          }
        ];
      };
      submissions_with_grades_for_assignment_and_regression_test: {
        Row: {
          activesubmissionid: number | null;
          assignment_id: number | null;
          autograder_score: number | null;
          class_id: number | null;
          created_at: string | null;
          grader_action_sha: string | null;
          grader_sha: string | null;
          groupname: string | null;
          id: number | null;
          name: string | null;
          released: string | null;
          repository: string | null;
          rt_autograder_score: number | null;
          rt_grader_action_sha: string | null;
          rt_grader_sha: string | null;
          sha: string | null;
          sortable_name: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "user_roles_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id"];
          }
        ];
      };
    };
    Functions: {
      authorize_for_private_discussion_thread: {
        Args: { root: number };
        Returns: boolean;
      };
      authorize_for_submission: {
        Args: { requested_submission_id: number };
        Returns: boolean;
      };
      authorize_for_submission_review: {
        Args: { submission_review_id: number };
        Returns: boolean;
      };
      authorize_for_submission_reviewable: {
        Args: {
          requested_submission_id: number;
          requested_submission_review_id: number;
        };
        Returns: boolean;
      };
      authorize_to_create_own_due_date_extension: {
        Args: {
          _student_id: string;
          _assignment_group_id: number;
          _assignment_id: number;
          _class_id: number;
          _creator_id: string;
          _hours_to_extend: number;
          _tokens_consumed: number;
        };
        Returns: boolean;
      };
      authorizeforassignmentgroup: {
        Args: { _assignment_group_id: number };
        Returns: boolean;
      };
      authorizeforclass: {
        Args: { class__id: number };
        Returns: boolean;
      };
      authorizeforclassgrader: {
        Args: { class__id: number };
        Returns: boolean;
      };
      authorizeforclassinstructor: {
        Args: { class__id: number };
        Returns: boolean;
      };
      authorizeforinstructorofstudent: {
        Args: { _user_id: string };
        Returns: boolean;
      };
      authorizeforinstructororgraderofstudent: {
        Args: { _user_id: string };
        Returns: boolean;
      };
      authorizeforpoll: {
        Args: { poll__id: number } | { poll__id: number; class__id: number };
        Returns: boolean;
      };
      authorizeforprofile: {
        Args: { profile_id: string };
        Returns: boolean;
      };
      auto_assign_self_reviews: {
        Args: { this_assignment_id: number; this_profile_id: string };
        Returns: undefined;
      };
      check_assignment_deadlines_passed: {
        Args: Record<PropertyKey, never>;
        Returns: undefined;
      };
      custom_access_token_hook: {
        Args: { event: Json };
        Returns: Json;
      };
      generate_anon_name: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      get_user_id_by_email: {
        Args: { email: string };
        Returns: {
          id: string;
        }[];
      };
      intval: {
        Args: { "": string };
        Returns: number;
      };
      is_allowed_grader_key: {
        Args: { graderkey: string; class: number };
        Returns: boolean;
      };
      is_in_class: {
        Args: { userid: string; classid: number };
        Returns: boolean;
      };
      is_instructor_for_class: {
        Args: { _person_id: string; _class_id: number } | { _person_id: string; classid: number };
        Returns: boolean;
      };
      is_instructor_for_student: {
        Args: { _person_id: string; _student_id: string };
        Returns: boolean;
      };
      submission_set_active: {
        Args: { _submission_id: number };
        Returns: boolean;
      };
    };
    Enums: {
      allowed_modes: "private" | "public" | "question" | "note";
      app_role: "admin" | "instructor" | "grader" | "student";
      assignment_group_join_status: "pending" | "approved" | "rejected" | "withdrawn";
      assignment_group_mode: "individual" | "groups" | "both";
      feedback_visibility: "visible" | "hidden" | "after_due_date" | "after_published";
      review_round: "self-review" | "grading-review" | "meta-grading-review";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DefaultSchema = Database[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database;
  }
    ? keyof (Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        Database[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? (Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      Database[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"] | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database;
  }
    ? keyof Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"] | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database;
  }
    ? keyof Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"] | { schema: keyof Database },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof Database;
  }
    ? keyof Database[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"] | { schema: keyof Database },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof Database;
  }
    ? keyof Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof Database }
  ? Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  pgmq_public: {
    Enums: {}
  },
  public: {
    Enums: {
      allowed_modes: ["private", "public", "question", "note"],
      app_role: ["admin", "instructor", "grader", "student"],
      assignment_group_join_status: ["pending", "approved", "rejected", "withdrawn"],
      assignment_group_mode: ["individual", "groups", "both"],
      feedback_visibility: ["visible", "hidden", "after_due_date", "after_published"],
      review_round: ["self-review", "grading-review", "meta-grading-review"]
    }
  }
} as const;
