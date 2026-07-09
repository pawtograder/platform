-- Track a per-repository creation failure reason.
--
-- When GitHub repo creation fails deterministically (e.g. the template/source repo is empty or
-- missing), the async worker records the reason here and leaves is_github_ready=false, instead of
-- silently retrying forever or deleting the row. The instructor UI surfaces this, and the reconciler
-- uses it to distinguish transient-pending repos (creation_error IS NULL) from terminal ones.

ALTER TABLE public.repositories
ADD COLUMN IF NOT EXISTS creation_error text;

COMMENT ON COLUMN public.repositories.creation_error IS
'Human-readable reason the most recent GitHub repo-creation attempt failed deterministically
(e.g. the template/source repo is empty or missing). NULL when the repo is pending or ready.
Cleared automatically when is_github_ready becomes true.';
