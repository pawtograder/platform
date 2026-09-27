-- E2E support: record GitHub API calls made by the edge functions when
-- PAWTOGRADER_GITHUB_STUB=1 is set in the environment. The stub seam in
-- supabase/functions/_shared/GitHubWrapper.ts writes a row here in place of
-- talking to real GitHub. Tests read these rows to assert what would have
-- happened.
--
-- Production safety: nothing writes to this table when the stub env var is
-- unset, so this is a no-op in production. RLS is enabled with no policies,
-- so only the service role can see / mutate rows.

create table if not exists public.e2e_github_calls (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  fn text not null,
  args jsonb not null,
  scope text
);

alter table public.e2e_github_calls enable row level security;

-- No policies — service role bypasses RLS; authenticated users see nothing.

comment on table public.e2e_github_calls is
  'E2E-only: rows written by GitHubWrapper.ts when PAWTOGRADER_GITHUB_STUB=1. Tests assert against these instead of hitting GitHub.';
comment on column public.e2e_github_calls.fn is
  'Name of the GitHubWrapper function that was stubbed (e.g. createRepo, applyBranchProtectionRuleset, mergeForkUpstream).';
comment on column public.e2e_github_calls.args is
  'JSON-encoded arguments captured for assertion. Shape varies per fn.';
comment on column public.e2e_github_calls.scope is
  'Optional debug_id / scope identifier the caller passed through.';
