export type PollQuestion = Record<string, unknown> | null;

export type LivePoll = {
  id: string;
  class_id: number;
  created_by: string;
  title: string;
  question: PollQuestion;
  is_live: boolean;
  created_at: string;
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

