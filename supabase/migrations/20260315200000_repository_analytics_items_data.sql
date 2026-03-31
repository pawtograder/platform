-- Add JSONB data column to repository_analytics_items for additional item-specific data
-- (e.g. files with +/- lines for commits/PRs, labels/body_preview for issues)

alter table "public"."repository_analytics_items"
  add column if not exists "data" jsonb default null;
