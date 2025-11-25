-- Add require_login boolean column to live_polls table
ALTER TABLE live_polls
ADD COLUMN require_login BOOLEAN NOT NULL DEFAULT FALSE;

