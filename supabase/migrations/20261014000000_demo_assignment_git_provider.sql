-- DEMO ONLY (Cloud Workspaces, Checkpoint 1): per-assignment git provider.
-- Lets an instructor choose whether an assignment's repos live on GitHub or Forgejo.
-- Nothing reads this yet except the UI; repo creation still goes to GitHub.
alter table "public"."assignments"
  add column "git_provider" text not null default 'github'
  constraint assignments_git_provider_check check (git_provider in ('github', 'forgejo'));
