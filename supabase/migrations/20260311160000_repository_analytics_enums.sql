-- Add PostgreSQL ENUMs for repository analytics status, item_type, and kpi_category
-- so the TypeScript generator emits enum types instead of plain strings.

-- 1. Create enum types (descriptive names, distinct from table names)
create type "public"."repo_analytics_fetch_status" as enum ('idle', 'fetching', 'completed', 'error');
create type "public"."repo_analytics_item_type" as enum ('issue', 'pr', 'commit', 'issue_comment', 'pr_review_comment');
create type "public"."repo_analytics_kpi_category" as enum (
  'issues_opened', 'issues_closed', 'issue_comments',
  'prs_opened', 'pr_review_comments', 'commits'
);

-- 2. repository_analytics_fetch_status.status (drop default before type change, re-add after)
alter table "public"."repository_analytics_fetch_status"
  drop constraint if exists "repository_analytics_fetch_status_status_check";
alter table "public"."repository_analytics_fetch_status"
  alter column "status" drop default;
alter table "public"."repository_analytics_fetch_status"
  alter column "status" type "public"."repo_analytics_fetch_status"
  using status::"public"."repo_analytics_fetch_status";
alter table "public"."repository_analytics_fetch_status"
  alter column "status" set default 'idle'::"public"."repo_analytics_fetch_status";

-- 3. repository_analytics_items.item_type
alter table "public"."repository_analytics_items"
  drop constraint if exists "repository_analytics_items_item_type_check";
alter table "public"."repository_analytics_items"
  alter column "item_type" type "public"."repo_analytics_item_type"
  using item_type::"public"."repo_analytics_item_type";

-- 4. rubric_checks.kpi_category (nullable, so allow null in using)
alter table "public"."rubric_checks"
  drop constraint if exists "rubric_checks_kpi_category_check";
alter table "public"."rubric_checks"
  alter column "kpi_category" type "public"."repo_analytics_kpi_category"
  using case when kpi_category is null then null else kpi_category::"public"."repo_analytics_kpi_category" end;
