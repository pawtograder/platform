export type WorkSessionWithDetails = {
  id: number;
  help_request_id: number;
  class_id: number;
  ta_profile_id: string;
  started_at: string;
  ended_at: string | null;
  queue_depth_at_start: number | null;
  longest_wait_seconds_at_start: number | null;
  notes: string | null;
  taName: string;
  studentName: string;
  durationSeconds: number;
  helpRequestTitle?: string;
};
