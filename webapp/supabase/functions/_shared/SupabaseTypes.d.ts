export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      assignments: {
        Row: {
          allow_late: boolean | null
          class_id: number | null
          created_at: string
          description: string | null
          due_date: string | null
          has_autograder: boolean | null
          has_handgrader: boolean | null
          id: number
          latest_due_date: string | null
          release_date: string | null
          slug: string | null
          student_repo_prefix: string | null
          submission_files: Json
          template_repo: string | null
          title: string | null
          total_points: number | null
        }
        Insert: {
          allow_late?: boolean | null
          class_id?: number | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          has_autograder?: boolean | null
          has_handgrader?: boolean | null
          id?: number
          latest_due_date?: string | null
          release_date?: string | null
          slug?: string | null
          student_repo_prefix?: string | null
          submission_files?: Json
          template_repo?: string | null
          title?: string | null
          total_points?: number | null
        }
        Update: {
          allow_late?: boolean | null
          class_id?: number | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          has_autograder?: boolean | null
          has_handgrader?: boolean | null
          id?: number
          latest_due_date?: string | null
          release_date?: string | null
          slug?: string | null
          student_repo_prefix?: string | null
          submission_files?: Json
          template_repo?: string | null
          title?: string | null
          total_points?: number | null
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
      autograder: {
        Row: {
          created_at: string
          grader_commit_sha: string | null
          grader_repo: string | null
          id: number
          workflow_sha: string | null
        }
        Insert: {
          created_at?: string
          grader_commit_sha?: string | null
          grader_repo?: string | null
          id: number
          workflow_sha?: string | null
        }
        Update: {
          created_at?: string
          grader_commit_sha?: string | null
          grader_repo?: string | null
          id?: number
          workflow_sha?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "grader_configs_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "assignments"
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
      classes: {
        Row: {
          canvas_id: number | null
          created_at: string
          github_org: string | null
          id: number
          is_demo: boolean
          name: string | null
          semester: number | null
          slug: string | null
          time_zone: string | null
        }
        Insert: {
          canvas_id?: number | null
          created_at?: string
          github_org?: string | null
          id?: number
          is_demo?: boolean
          name?: string | null
          semester?: number | null
          slug?: string | null
          time_zone?: string | null
        }
        Update: {
          canvas_id?: number | null
          created_at?: string
          github_org?: string | null
          id?: number
          is_demo?: boolean
          name?: string | null
          semester?: number | null
          slug?: string | null
          time_zone?: string | null
        }
        Relationships: []
      }
      discussion_thread_likes: {
        Row: {
          created_at: string
          creator: string
          discussion_thread: number
          emoji: string
          id: number
        }
        Insert: {
          created_at?: string
          creator: string
          discussion_thread: number
          emoji: string
          id?: number
        }
        Update: {
          created_at?: string
          creator?: string
          discussion_thread?: number
          emoji?: string
          id?: number
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
        ]
      }
      discussion_thread_read_status: {
        Row: {
          created_at: string
          discussion_thread_id: number
          discussion_thread_root_id: number
          id: number
          read_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          discussion_thread_id: number
          discussion_thread_root_id: number
          id?: number
          read_at?: string | null
          user_id?: string
        }
        Update: {
          created_at?: string
          discussion_thread_id?: number
          discussion_thread_root_id?: number
          id?: number
          read_at?: string | null
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
      discussion_thread_watchers: {
        Row: {
          class_id: number
          created_at: string
          discussion_thread_root_id: number
          enabled: boolean
          id: number
          user_id: string
        }
        Insert: {
          class_id: number
          created_at?: string
          discussion_thread_root_id: number
          enabled?: boolean
          id?: number
          user_id: string
        }
        Update: {
          class_id?: number
          created_at?: string
          discussion_thread_root_id?: number
          enabled?: boolean
          id?: number
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
          root: number | null
          root_class_id: number | null
          subject: string
          topic_id: number
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
          root?: number | null
          root_class_id?: number | null
          subject: string
          topic_id: number
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
          root?: number | null
          root_class_id?: number | null
          subject?: string
          topic_id?: number
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
      discussion_topics: {
        Row: {
          class_id: number
          color: string
          created_at: string
          description: string
          id: number
          ordinal: number
          topic: string
        }
        Insert: {
          class_id: number
          color: string
          created_at?: string
          description: string
          id?: number
          ordinal?: number
          topic: string
        }
        Update: {
          class_id?: number
          color?: string
          created_at?: string
          description?: string
          id?: number
          ordinal?: number
          topic?: string
        }
        Relationships: [
          {
            foreignKeyName: "discussion_topics_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
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
      grader_result_output: {
        Row: {
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
        ]
      }
      grader_result_tests: {
        Row: {
          class_id: number
          created_at: string
          extra_data: Json | null
          grader_result_id: number
          id: number
          max_score: number | null
          name: string
          name_format: string
          output: string | null
          output_format: string | null
          part: string | null
          score: number | null
          student_id: string | null
        }
        Insert: {
          class_id: number
          created_at?: string
          extra_data?: Json | null
          grader_result_id: number
          id?: number
          max_score?: number | null
          name: string
          name_format?: string
          output?: string | null
          output_format?: string | null
          part?: string | null
          score?: number | null
          student_id?: string | null
        }
        Update: {
          class_id?: number
          created_at?: string
          extra_data?: Json | null
          grader_result_id?: number
          id?: number
          max_score?: number | null
          name?: string
          name_format?: string
          output?: string | null
          output_format?: string | null
          part?: string | null
          score?: number | null
          student_id?: string | null
        }
        Relationships: [
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
            foreignKeyName: "grader_test_results_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      grader_results: {
        Row: {
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
            foreignKeyName: "grader_results_user_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
          name: string
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
          name: string
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
          name?: string
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
      help_request_messages: {
        Row: {
          author: string
          class_id: number
          created_at: string
          help_request_id: number
          id: number
          instructors_only: boolean
          message: string
          requestor: string | null
        }
        Insert: {
          author: string
          class_id: number
          created_at?: string
          help_request_id: number
          id?: number
          instructors_only?: boolean
          message: string
          requestor?: string | null
        }
        Update: {
          author?: string
          class_id?: number
          created_at?: string
          help_request_id?: number
          id?: number
          instructors_only?: boolean
          message?: string
          requestor?: string | null
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
        ]
      }
      help_requests: {
        Row: {
          assignee: string | null
          class_id: number
          created_at: string
          creator: string
          followup_to: number | null
          help_queue: number
          id: number
          is_video_live: boolean
          request: string
          resolved_at: string | null
          resolved_by: string | null
        }
        Insert: {
          assignee?: string | null
          class_id: number
          created_at?: string
          creator: string
          followup_to?: number | null
          help_queue: number
          id?: number
          is_video_live?: boolean
          request: string
          resolved_at?: string | null
          resolved_by?: string | null
        }
        Update: {
          assignee?: string | null
          class_id?: number
          created_at?: string
          creator?: string
          followup_to?: number | null
          help_queue?: number
          id?: number
          is_video_live?: boolean
          request?: string
          resolved_at?: string | null
          resolved_by?: string | null
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
            foreignKeyName: "help_requests_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_requests_creator_fkey"
            columns: ["creator"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_requests_help_queue_fkey"
            columns: ["help_queue"]
            isOneToOne: false
            referencedRelation: "help_queues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "help_requests_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
      notifications: {
        Row: {
          body: Json
          class_id: number
          created_at: string
          id: number
          style: string | null
          subject: Json
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
      poll_question_answers: {
        Row: {
          class_id: number
          created_at: string
          description: string | null
          id: number
          ordinal: number
          poll: number
          poll_question: number
          title: string
        }
        Insert: {
          class_id: number
          created_at?: string
          description?: string | null
          id?: number
          ordinal?: number
          poll: number
          poll_question: number
          title: string
        }
        Update: {
          class_id?: number
          created_at?: string
          description?: string | null
          id?: number
          ordinal?: number
          poll?: number
          poll_question?: number
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "poll_question_answers_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "poll_question_answers_poll_fkey"
            columns: ["poll"]
            isOneToOne: false
            referencedRelation: "polls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "poll_question_answers_poll_question_fkey"
            columns: ["poll_question"]
            isOneToOne: false
            referencedRelation: "poll_questions"
            referencedColumns: ["id"]
          },
        ]
      }
      poll_question_results: {
        Row: {
          count: number
          created_at: string
          id: number
          poll: number
          poll_question: number
          poll_question_answer: number
        }
        Insert: {
          count?: number
          created_at?: string
          id?: number
          poll: number
          poll_question: number
          poll_question_answer: number
        }
        Update: {
          count?: number
          created_at?: string
          id?: number
          poll?: number
          poll_question?: number
          poll_question_answer?: number
        }
        Relationships: [
          {
            foreignKeyName: "poll_question_results_poll_fkey"
            columns: ["poll"]
            isOneToOne: false
            referencedRelation: "polls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "poll_question_results_poll_question_answer_fkey"
            columns: ["poll_question_answer"]
            isOneToOne: false
            referencedRelation: "poll_question_answers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "poll_question_results_poll_question_fkey"
            columns: ["poll_question"]
            isOneToOne: false
            referencedRelation: "poll_questions"
            referencedColumns: ["id"]
          },
        ]
      }
      poll_questions: {
        Row: {
          class_id: number
          created_at: string
          description: string | null
          id: number
          poll: number
          question_type: string
          title: string
        }
        Insert: {
          class_id: number
          created_at?: string
          description?: string | null
          id?: number
          poll: number
          question_type?: string
          title: string
        }
        Update: {
          class_id?: number
          created_at?: string
          description?: string | null
          id?: number
          poll?: number
          question_type?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "poll_questions_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "poll_questions_poll_fkey"
            columns: ["poll"]
            isOneToOne: false
            referencedRelation: "polls"
            referencedColumns: ["id"]
          },
        ]
      }
      poll_response_answers: {
        Row: {
          created_at: string
          id: number
          poll: number
          poll_question: number
          poll_question_answer: number
          poll_response: number
          profile_id: string
        }
        Insert: {
          created_at?: string
          id?: number
          poll: number
          poll_question: number
          poll_question_answer: number
          poll_response: number
          profile_id?: string
        }
        Update: {
          created_at?: string
          id?: number
          poll?: number
          poll_question?: number
          poll_question_answer?: number
          poll_response?: number
          profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "poll_response_answers_poll_fkey"
            columns: ["poll"]
            isOneToOne: false
            referencedRelation: "polls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "poll_response_answers_poll_question_answer_fkey"
            columns: ["poll_question_answer"]
            isOneToOne: false
            referencedRelation: "poll_question_answers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "poll_response_answers_poll_question_fkey"
            columns: ["poll_question"]
            isOneToOne: false
            referencedRelation: "poll_questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "poll_response_answers_poll_response_fkey"
            columns: ["poll_response"]
            isOneToOne: false
            referencedRelation: "poll_responses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "poll_response_answers_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      poll_responses: {
        Row: {
          class_id: number
          created_at: string
          ended_at: string | null
          id: number
          poll: number
          profile_id: string
        }
        Insert: {
          class_id: number
          created_at?: string
          ended_at?: string | null
          id?: number
          poll: number
          profile_id: string
        }
        Update: {
          class_id?: number
          created_at?: string
          ended_at?: string | null
          id?: number
          poll?: number
          profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "poll_responses_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "poll_responses_poll_fkey"
            columns: ["poll"]
            isOneToOne: false
            referencedRelation: "polls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "poll_responses_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      polls: {
        Row: {
          class_id: number
          created_at: string
          description: string | null
          due_date: string | null
          flair: Json | null
          id: number
          name: string
          released_at: string | null
        }
        Insert: {
          class_id: number
          created_at?: string
          description?: string | null
          due_date?: string | null
          flair?: Json | null
          id?: number
          name: string
          released_at?: string | null
        }
        Update: {
          class_id?: number
          created_at?: string
          description?: string | null
          due_date?: string | null
          flair?: Json | null
          id?: number
          name?: string
          released_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "polls_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          class_id: number
          created_at: string
          flair: string | null
          flair_color: string | null
          id: string
          name: string | null
          short_name: string | null
          sis_user_id: string | null
          sortable_name: string | null
          time_zone: string | null
        }
        Insert: {
          avatar_url?: string | null
          class_id: number
          created_at?: string
          flair?: string | null
          flair_color?: string | null
          id?: string
          name?: string | null
          short_name?: string | null
          sis_user_id?: string | null
          sortable_name?: string | null
          time_zone?: string | null
        }
        Update: {
          avatar_url?: string | null
          class_id?: number
          created_at?: string
          flair?: string | null
          flair_color?: string | null
          id?: string
          name?: string | null
          short_name?: string | null
          sis_user_id?: string | null
          sortable_name?: string | null
          time_zone?: string | null
        }
        Relationships: []
      }
      repositories: {
        Row: {
          assignment_id: number
          class_id: number
          created_at: string
          id: number
          profile_id: string
          repository: string
        }
        Insert: {
          assignment_id: number
          class_id: number
          created_at?: string
          id?: number
          profile_id: string
          repository: string
        }
        Update: {
          assignment_id?: number
          class_id?: number
          created_at?: string
          id?: number
          profile_id?: string
          repository?: string
        }
        Relationships: [
          {
            foreignKeyName: "repositories_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
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
        ]
      }
      rubrics: {
        Row: {
          class_id: number | null
          created_at: string
          deduction: number
          id: number
          name: string | null
          ordinal: number
        }
        Insert: {
          class_id?: number | null
          created_at?: string
          deduction: number
          id?: number
          name?: string | null
          ordinal: number
        }
        Update: {
          class_id?: number | null
          created_at?: string
          deduction?: number
          id?: number
          name?: string | null
          ordinal?: number
        }
        Relationships: [
          {
            foreignKeyName: "assignment_rubric_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      submission_file_comments: {
        Row: {
          author: string
          class_id: number
          comment: string
          created_at: string
          deduction: number | null
          id: number
          line: number
          submission_files_id: number
          submissions_id: number
        }
        Insert: {
          author: string
          class_id: number
          comment: string
          created_at?: string
          deduction?: number | null
          id?: number
          line: number
          submission_files_id: number
          submissions_id: number
        }
        Update: {
          author?: string
          class_id?: number
          comment?: string
          created_at?: string
          deduction?: number | null
          id?: number
          line?: number
          submission_files_id?: number
          submissions_id?: number
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
            foreignKeyName: "submission_file_lcomments_author_fkey"
            columns: ["author"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_file_lcomments_submission_files_id_fkey"
            columns: ["submission_files_id"]
            isOneToOne: false
            referencedRelation: "submission_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_file_lcomments_submissions_id_fkey"
            columns: ["submissions_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_file_lcomments_submissions_id_fkey"
            columns: ["submissions_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["id"]
          },
        ]
      }
      submission_files: {
        Row: {
          class_id: number
          contents: string
          created_at: string
          id: number
          name: string
          profile_id: string
          submissions_id: number
        }
        Insert: {
          class_id: number
          contents: string
          created_at?: string
          id?: number
          name: string
          profile_id: string
          submissions_id: number
        }
        Update: {
          class_id?: number
          contents?: string
          created_at?: string
          id?: number
          name?: string
          profile_id?: string
          submissions_id?: number
        }
        Relationships: [
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
            referencedRelation: "user_roles"
            referencedColumns: ["private_profile_id"]
          },
          {
            foreignKeyName: "submission_files_submissions_id_fkey"
            columns: ["submissions_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_files_submissions_id_fkey"
            columns: ["submissions_id"]
            isOneToOne: false
            referencedRelation: "submissions_agg"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_files_user_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      submissions: {
        Row: {
          assignment_id: number
          check_run_id: number | null
          class_id: number
          created_at: string
          id: number
          ordinal: number
          profile_id: string
          released: string | null
          repository: string
          run_attempt: number
          run_number: number
          sha: string
        }
        Insert: {
          assignment_id: number
          check_run_id?: number | null
          class_id: number
          created_at?: string
          id?: number
          ordinal?: number
          profile_id: string
          released?: string | null
          repository: string
          run_attempt: number
          run_number: number
          sha: string
        }
        Update: {
          assignment_id?: number
          check_run_id?: number | null
          class_id?: number
          created_at?: string
          id?: number
          ordinal?: number
          profile_id?: string
          released?: string | null
          repository?: string
          run_attempt?: number
          run_number?: number
          sha?: string
        }
        Relationships: [
          {
            foreignKeyName: "submissio_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissio_user_id_fkey1"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
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
            foreignKeyName: "submissions_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "user_roles"
            referencedColumns: ["private_profile_id"]
          },
        ]
      }
      user_roles: {
        Row: {
          canvas_id: number | null
          class_id: number
          id: number
          private_profile_id: string
          public_profile_id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          canvas_id?: number | null
          class_id: number
          id?: number
          private_profile_id: string
          public_profile_id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          canvas_id?: number | null
          class_id?: number
          id?: number
          private_profile_id?: string
          public_profile_id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
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
            foreignKeyName: "user_roles_private_profile_id_fkey"
            columns: ["private_profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_roles_public_profile_id_fkey"
            columns: ["public_profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
          github_username: string | null
          name: string | null
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          github_username?: string | null
          name?: string | null
          user_id?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          github_username?: string | null
          name?: string | null
          user_id?: string
        }
        Relationships: []
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
    }
    Views: {
      autograder_regression_test_by_grader: {
        Row: {
          class_id: number | null
          grader_repo: string | null
          id: number | null
          repository: string | null
          sha: string | null
        }
        Relationships: [
          {
            foreignKeyName: "submissions_class_id_fkey"
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
          created_at: string | null
          execution_time: number | null
          id: number | null
          latestsubmissionid: number | null
          released: string | null
          repository: string | null
          ret_code: number | null
          run_attempt: number | null
          run_number: number | null
          score: number | null
          sha: string | null
          submissioncount: number | null
          user_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "submissio_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissio_user_id_fkey1"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_profile_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_roles"
            referencedColumns: ["private_profile_id"]
          },
        ]
      }
    }
    Functions: {
      authorizeforclass: {
        Args: {
          class__id: number
        }
        Returns: boolean
      }
      authorizeforclassinstructor: {
        Args: {
          class__id: number
        }
        Returns: boolean
      }
      authorizeforinstructorofstudent:
        | {
            Args: {
              _user_id: string
            }
            Returns: boolean
          }
        | {
            Args: {
              user_id: number
            }
            Returns: boolean
          }
      authorizeforpoll:
        | {
            Args: {
              poll__id: number
            }
            Returns: boolean
          }
        | {
            Args: {
              poll__id: number
              class__id: number
            }
            Returns: boolean
          }
      authorizeforprofile: {
        Args: {
          profile_id: string
        }
        Returns: boolean
      }
      custom_access_token_hook: {
        Args: {
          event: Json
        }
        Returns: Json
      }
      generate_anon_name: {
        Args: Record<PropertyKey, never>
        Returns: string
      }
      get_user_id_by_email: {
        Args: {
          email: string
        }
        Returns: {
          id: string
        }[]
      }
      intval: {
        Args: {
          "": string
        }
        Returns: number
      }
      is_allowed_grader_key: {
        Args: {
          graderkey: string
          class: number
        }
        Returns: boolean
      }
      is_in_class: {
        Args: {
          userid: string
          classid: number
        }
        Returns: boolean
      }
      is_instructor_for_class:
        | {
            Args: {
              _person_id: string
              _class_id: number
            }
            Returns: boolean
          }
        | {
            Args: {
              _person_id: string
              classid: number
            }
            Returns: boolean
          }
      is_instructor_for_student: {
        Args: {
          _person_id: string
          _student_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      allowed_modes: "private" | "public" | "question" | "note"
      app_role: "admin" | "instructor" | "grader" | "student"
      feedback_visibility:
        | "visible"
        | "hidden"
        | "after_due_date"
        | "after_published"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type PublicSchema = Database[Extract<keyof Database, "public">]

export type Tables<
  PublicTableNameOrOptions extends
    | keyof (PublicSchema["Tables"] & PublicSchema["Views"])
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
        Database[PublicTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
      Database[PublicTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : PublicTableNameOrOptions extends keyof (PublicSchema["Tables"] &
        PublicSchema["Views"])
    ? (PublicSchema["Tables"] &
        PublicSchema["Views"])[PublicTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  PublicTableNameOrOptions extends
    | keyof PublicSchema["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : PublicTableNameOrOptions extends keyof PublicSchema["Tables"]
    ? PublicSchema["Tables"][PublicTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  PublicTableNameOrOptions extends
    | keyof PublicSchema["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : PublicTableNameOrOptions extends keyof PublicSchema["Tables"]
    ? PublicSchema["Tables"][PublicTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  PublicEnumNameOrOptions extends
    | keyof PublicSchema["Enums"]
    | { schema: keyof Database },
  EnumName extends PublicEnumNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = PublicEnumNameOrOptions extends { schema: keyof Database }
  ? Database[PublicEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : PublicEnumNameOrOptions extends keyof PublicSchema["Enums"]
    ? PublicSchema["Enums"][PublicEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof PublicSchema["CompositeTypes"]
    | { schema: keyof Database },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof Database }
  ? Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof PublicSchema["CompositeTypes"]
    ? PublicSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never
