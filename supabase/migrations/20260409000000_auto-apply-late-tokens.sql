ALTER TABLE assignments
  ADD COLUMN require_tokens_before_due_date boolean NOT NULL DEFAULT true;
