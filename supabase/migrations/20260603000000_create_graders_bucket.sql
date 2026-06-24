-- Private storage bucket for cached grader archives (repo tarballs).
--
-- Populated and read exclusively by the service-role client in
-- supabase/functions/_shared/GitHubWrapper.ts, which uploads
-- `${repo}/${sha}/archive.tgz` and hands out short-lived signed URLs. Access
-- is service-role only (which bypasses RLS), so no storage.objects policies are
-- required — keep the bucket private so the tarballs are never publicly listable
-- or fetchable without a signed URL.
--
-- Idempotent: existing deployments already have this bucket created out-of-band;
-- ON CONFLICT keeps the migration a no-op there.
INSERT INTO storage.buckets (id, name, public)
VALUES ('graders', 'graders', false)
ON CONFLICT (id) DO NOTHING;
