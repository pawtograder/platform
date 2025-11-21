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

export type LivePoll = {
  id: string;
  class_id: number;
  created_by: string;
  question: JSON;
  is_live: boolean;
  created_at: string;
  deactivates_at?: string | null;
};

export type LivePollResponse = {
  id: string;
  live_poll_id: string;
  public_profile_id: string;
  response: Record<string, unknown> | null;
  submitted_at: string | null;
  is_submitted: boolean;
  created_at: string;
};

