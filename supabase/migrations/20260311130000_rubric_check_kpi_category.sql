-- Add kpi_category to rubric_checks so checks can reference repository analytics KPIs
alter table "public"."rubric_checks"
  add column if not exists "kpi_category" text default null
  check (kpi_category is null or kpi_category in (
    'issues_opened', 'issues_closed', 'issue_comments',
    'prs_opened', 'pr_review_comments', 'commits'
  ));
