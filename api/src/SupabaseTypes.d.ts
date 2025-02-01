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
          template_repo: Json | null
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
          template_repo?: Json | null
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
          template_repo?: Json | null
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
      classes: {
        Row: {
          canvas_id: number | null
          created_at: string
          id: number
          name: string | null
          semester: number | null
          slug: string | null
          time_zone: string | null
        }
        Insert: {
          canvas_id?: number | null
          created_at?: string
          id?: number
          name?: string | null
          semester?: number | null
          slug?: string | null
          time_zone?: string | null
        }
        Update: {
          canvas_id?: number | null
          created_at?: string
          id?: number
          name?: string | null
          semester?: number | null
          slug?: string | null
          time_zone?: string | null
        }
        Relationships: []
      }
      grader_configs: {
        Row: {
          assignment_id: number
          config: Json
          created_at: string
          grader_commit_sha: string | null
          grader_repo: string | null
          workflow_sha: string | null
        }
        Insert: {
          assignment_id: number
          config: Json
          created_at?: string
          grader_commit_sha?: string | null
          grader_repo?: string | null
          workflow_sha?: string | null
        }
        Update: {
          assignment_id?: number
          config?: Json
          created_at?: string
          grader_commit_sha?: string | null
          grader_repo?: string | null
          workflow_sha?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "grader_configs_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: true
            referencedRelation: "assignments"
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
      grader_results: {
        Row: {
          created_at: string
          errors: Json | null
          execution_time: number | null
          feedback: Json | null
          grader_sha: string | null
          output: Json | null
          ret_code: number | null
          score: number
          submission_id: number
        }
        Insert: {
          created_at?: string
          errors?: Json | null
          execution_time?: number | null
          feedback?: Json | null
          grader_sha?: string | null
          output?: Json | null
          ret_code?: number | null
          score: number
          submission_id: number
        }
        Update: {
          created_at?: string
          errors?: Json | null
          execution_time?: number | null
          feedback?: Json | null
          grader_sha?: string | null
          output?: Json | null
          ret_code?: number | null
          score?: number
          submission_id?: number
        }
        Relationships: []
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
          created_at: string
          github_username: string | null
          id: string
          name: string | null
          short_name: string | null
          sis_user_id: string | null
          sortable_name: string | null
          time_zone: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          github_username?: string | null
          id: string
          name?: string | null
          short_name?: string | null
          sis_user_id?: string | null
          sortable_name?: string | null
          time_zone?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          github_username?: string | null
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
          created_at: string
          id: number
          repository: string
          user_id: string
        }
        Insert: {
          assignment_id: number
          created_at?: string
          id?: number
          repository: string
          user_id: string
        }
        Update: {
          assignment_id?: number
          created_at?: string
          id?: number
          repository?: string
          user_id?: string
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
            foreignKeyName: "repositories_user_id_fkey1"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      submission_files: {
        Row: {
          contents: string
          created_at: string
          id: number
          name: string
          submissions_id: number
        }
        Insert: {
          contents: string
          created_at?: string
          id?: number
          name: string
          submissions_id: number
        }
        Update: {
          contents?: string
          created_at?: string
          id?: number
          name?: string
          submissions_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "submission_files_submissions_id_fkey"
            columns: ["submissions_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      submissions: {
        Row: {
          assignment_id: number
          created_at: string
          id: number
          released: string | null
          repository: string
          run_attempt: number
          run_number: number
          sha: string
          user_id: string
        }
        Insert: {
          assignment_id: number
          created_at?: string
          id?: number
          released?: string | null
          repository: string
          run_attempt: number
          run_number: number
          sha: string
          user_id: string
        }
        Update: {
          assignment_id?: number
          created_at?: string
          id?: number
          released?: string | null
          repository?: string
          run_attempt?: number
          run_number?: number
          sha?: string
          user_id?: string
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
        ]
      }
      user_roles: {
        Row: {
          canvas_id: number | null
          class_id: number | null
          id: number
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          canvas_id?: number | null
          class_id?: number | null
          id?: number
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          canvas_id?: number | null
          class_id?: number | null
          id?: number
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
            foreignKeyName: "user_roles_user_id_fkey1"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      custom_access_token_hook: {
        Args: {
          event: Json
        }
        Returns: Json
      }
      is_allowed_grader_key: {
        Args: {
          graderkey: string
          class: number
        }
        Returns: boolean
      }
      is_instructor_for_class: {
        Args: {
          _person_id: string
          _class_id: number
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
      app_role: "admin" | "instructor" | "grader" | "student"
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
