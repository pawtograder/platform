// Shared survey types to avoid duplication across files

export type ResponseData = Record<string, any>;

export type SurveyResponse = {
  id: string;
  survey_id: string;         
  profile_id: string;       
  response: ResponseData;
  is_submitted: boolean;
  submitted_at?: string;
  created_at?: string;
  updated_at?: string;
};

export type SurveyResponseWithProfile = SurveyResponse & {
  profiles: {
    id: string;
    name: string;
    sis_user_id: string | null;
  };
};

export type Survey = {
  id: string;
  title: string;
  description?: string;
  json: any;
  due_date?: string;
  allow_response_editing: boolean;
  status: "draft" | "published" | "closed";
  created_at?: string;
  updated_at?: string;
};

export type SurveyWithResponse = Survey & {
  response_status: "not_started" | "in_progress" | "completed";
  submitted_at?: string;
  is_submitted?: boolean;
};

export type SurveyWithCounts = Survey & {
  response_count: number;
  submitted_count: number;
};
