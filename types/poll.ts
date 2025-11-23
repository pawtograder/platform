// Poll question structure - a single question object
export type PollQuestion = {
  id: string;
};

export type MultipleChoicePollQuestion = PollQuestion & {
  type: "multiple-choice";
  prompt: string;
  choices: {
    label: string;
  }[];
  correct_choices: string[];
};

import { Json } from "@/utils/supabase/SupabaseTypes";

export type LivePoll = {
  id: string;
  class_id: number;
  created_by: string;
  question: Json;
  is_live: boolean;
  created_at: string;
  deactivates_at?: string | null;
};

// Poll response format: { "poll_question_0": "Dynamic Programming" }
// Keys are dynamic (poll_question_0, poll_question_1, etc.)
// Values can be string (single choice) or string[] (multiple choice)
export type PollResponseData = Record<string, string | string[]>;

export type LivePollResponse = {
  id: string;
  live_poll_id: string;
  public_profile_id: string;
  response: PollResponseData | null;
  submitted_at: string | null;
  is_submitted: boolean;
  created_at: string;
};

