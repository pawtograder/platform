#!/usr/bin/env bash
# One-off cleanup for the half-finished delete of CS 3650 fa26 "Project 1: Shell"
# (assignment 1259, class 647) in pawtograder-prod.
#
# What happened (2026-10-15 11:01Z): assignment-delete queued 239 archive_repo_and_lock
# jobs (237 student repos + handout + solution), then delete_assignment_with_all_data
# hit authenticator's 8s statement_timeout and rolled back. The archive jobs are
# independent of the DB and keep running, so GitHub is being cleaned up while the
# assignment, its repository rows and its gradebook column are still live. The
# instructor confirmed the assignment should be gone.
#
# This script finishes the job in ONE transaction:
#   1. enqueue archive jobs for any target the 11:01Z run did not cover (expected:
#      fa26-p1-shell-awjacks, created at 11:11Z after the jobs were queued)
#   2. call delete_assignment_with_all_data(1259, 647) with a 120s statement_timeout
#   3. assert the assignment and its repository rows are gone
# pgmq.send is transactional, so if the delete fails nothing is enqueued either.
#
# Modes (run in this order):
#   --check     read-only: guards, row counts, archive coverage, GitHub cross-check (default)
#   --dry-run   run the full transaction with \timing, then ROLLBACK
#   --apply     run the full transaction and COMMIT
#   --purge-orphan-syncs   delete queued sync_repo_to_handout jobs for the deleted repos
#
# Orphaned syncs: a "sync to handout" on 1259 at 12:00:54Z queued 238 sync_repo_to_handout
# jobs behind the archives. --apply deleted the repository rows they name, but the worker
# does not stop on a missing row: the handout was force-pushed onto unrelated history, the
# compare 404s ("unknown" direction), and it goes on to write a sync branch into each repo.
# By the time they run the repos are archived, so each one 403s, retries and dead-letters
# while holding the per-org GitHub limiter. --purge-orphan-syncs removes only jobs whose
# template is the 1259 handout AND whose repository row no longer exists.
#
# Usage (from anywhere; point at the Khoury kubeconfig in prod-charts):
#   KUBECONFIG=~/work/pawtograder/prod-charts/kubeconfig scripts/oneoff/2026-10-15-delete-assignment-1259.sh --check
#
# Requires: kubectl, gh (read access to Khoury-CS3650; --check only).
set -euo pipefail

ASSIGNMENT_ID=1259
CLASS_ID=647
ORG="Khoury-CS3650"
NAMESPACE="pawtograder-prod"
PG_POD="pawtograder-postgres-0"
PROD_SERVER="https://rancher.khoury.northeastern.edu/k8s/clusters/c-nmrz5"

mode=check
case "${1:---check}" in
  --check)   mode=check ;;
  --dry-run) mode=dry-run ;;
  --apply)   mode=apply ;;
  --purge-orphan-syncs) mode=purge-orphan-syncs ;;
  -h|--help) grep '^#' "$0" | sed 's/^# \?//'; exit 0 ;;
  *) echo "unknown arg: $1 (use --check | --dry-run | --apply)" >&2; exit 2 ;;
esac

# The default shell KUBECONFIG points at ripley, where pawtograder-prod does not exist.
server="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
if [ "$server" != "$PROD_SERVER" ]; then
  echo "KUBECONFIG points at '$server', not the Khoury prod cluster ($PROD_SERVER)" >&2
  exit 1
fi

# psql as the postgres superuser inside the primary; SQL comes in on stdin.
psql_prod() {
  kubectl exec -i -n "$NAMESPACE" "$PG_POD" -c postgres -- \
    psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 \
      -v assignment_id="$ASSIGNMENT_ID" -v class_id="$CLASS_ID" "$@"
}

# Targets = what assignment-delete would collect: repository rows + template + grader repo.
# Covered = already has an archive_repo_and_lock message, pending or archived.
# A bare SELECT (no temp table) so --check can run it inside a read-only transaction;
# use it as `from (${TARGETS_SQL}) targets`.
TARGETS_SQL=$(cat <<'SQL'
with t as (
  select 'student' as kind, r.repository as full_name
    from public.repositories r where r.assignment_id = :assignment_id
  union
  select 'template', a.template_repo from public.assignments a where a.id = :assignment_id
  union
  select 'solution', ag.grader_repo from public.autograder ag where ag.id = :assignment_id
), jobs as (
  select lower((message->'args'->>'org') || '/' || (message->'args'->>'repo')) as full_name, 'pending' as state
    from pgmq.q_async_calls where message->>'method' = 'archive_repo_and_lock'
  union all
  select lower((message->'args'->>'org') || '/' || (message->'args'->>'repo')), 'done'
    from pgmq.a_async_calls where message->>'method' = 'archive_repo_and_lock'
)
select t.kind, t.full_name,
       split_part(t.full_name, '/', 1) as org,
       split_part(t.full_name, '/', 2) as repo,
       coalesce((select min(j.state) from jobs j where j.full_name = lower(t.full_name)), 'uncovered') as coverage
  from t
 where t.full_name is not null and t.full_name like '%/%'
SQL
)

check() {
  echo "==> DB state (read-only)"
  psql_prod <<SQL
begin read only;
\echo '-- assignment'
select id, title, slug, class_id, release_date, due_date, archived_at, gradebook_column_id
  from public.assignments where id = :assignment_id and class_id = :class_id;
\echo '-- guards: both must be 0'
select (select count(*) from public.submissions where assignment_id = :assignment_id) as submissions,
       (select count(*) from public.submission_reviews sr join public.submissions s on s.id = sr.submission_id
         where s.assignment_id = :assignment_id and sr.released) as released_reviews;
\echo '-- rows the RPC will delete'
select (select count(*) from public.repositories where assignment_id = :assignment_id) as repositories,
       (select count(*) from public.repository_check_runs rcr join public.repositories r on r.id = rcr.repository_id
         where r.assignment_id = :assignment_id) as check_runs,
       (select count(*) from public.gradebook_column_students gcs join public.assignments a on a.gradebook_column_id = gcs.gradebook_column_id
         where a.id = :assignment_id) as gradebook_column_students,
       (select count(*) from public.rubrics where assignment_id = :assignment_id) as rubrics,
       (select count(*) from public.assignment_handout_commits where assignment_id = :assignment_id) as handout_commits;
\echo '-- archive coverage (pending = still queued, done = archived, uncovered = will be enqueued by --apply)'
select kind, coverage, count(*) from (${TARGETS_SQL}) targets group by 1, 2 order by 1, 2;
\echo '-- uncovered targets'
select kind, full_name from (${TARGETS_SQL}) targets where coverage = 'uncovered' order by 1, 2;
rollback;
SQL

  echo "==> GitHub cross-check: live ${ORG} repos for this assignment that the DB does not know about"
  # Archived repos are renamed archived-<ts>-<name>, so live names never carry that prefix.
  # The org has ~25k repos and /orgs/{org}/repos stops well short of them, so use search
  # (capped at 1000 hits, plenty here; its index can lag renames by a few minutes).
  # The anchored regex excludes the replacement assignment 1262 (fa26-*new-p1-shell*).
  local db_targets gh_live missing
  db_targets="$(psql_prod -qAt <<SQL
begin read only;
select lower(full_name) from (${TARGETS_SQL}) targets order by 1;
rollback;
SQL
)"
  db_targets="$(printf '%s\n' "$db_targets" | grep '/' || true)"
  gh_live="$(gh api -X GET search/repositories -f q="org:${ORG} p1-shell in:name" -f per_page=100 \
      --paginate --jq '.items[].full_name' \
    | grep -iE "^${ORG}/fa26-(p1-shell-.+|handout-p1-shell|solution-p1-shell)$" \
    | tr '[:upper:]' '[:lower:]' | sort -u)"
  missing="$(comm -13 <(printf '%s\n' "$db_targets" | sort -u) <(printf '%s\n' "$gh_live"))"
  echo "live on GitHub: $(printf '%s\n' "$gh_live" | grep -c . || true)"
  if [ -n "$missing" ]; then
    echo "NOT covered by the DB targets (would be left behind; archive by hand):"
    printf '%s\n' "$missing" | sed 's/^/  /'
  else
    echo "none — every live repo is a DB target"
  fi
}

run_txn() {
  local finish="$1"
  echo "==> delete transaction (${finish})"
  psql_prod <<SQL
\timing on
begin;
set local statement_timeout = '120s';
set local lock_timeout = '5s';
-- Snapshot targets before the RPC deletes the repository rows they come from.
create temp table targets on commit drop as ${TARGETS_SQL};
\echo '-- enqueueing archive jobs for uncovered targets'
select t.kind, t.full_name,
       public.enqueue_github_archive_repo(:class_id, t.org, t.repo,
         'assignment-delete-' || :assignment_id || '-' || t.kind || '-manual-' || t.repo) as msg_id
  from targets t where t.coverage = 'uncovered' order by 1, 2;
\echo '-- delete_assignment_with_all_data'
select public.delete_assignment_with_all_data(:assignment_id, :class_id);
\echo '-- post-delete assertions'
select (select count(*) from public.assignments where id = :assignment_id) as assignments_left,
       (select count(*) from public.repositories where assignment_id = :assignment_id) as repositories_left;
do \$\$
begin
  if exists (select 1 from public.assignments where id = ${ASSIGNMENT_ID})
     or exists (select 1 from public.repositories where assignment_id = ${ASSIGNMENT_ID}) then
    raise exception 'assignment ${ASSIGNMENT_ID} or its repositories still present after delete';
  end if;
end
\$\$;
${finish};
SQL
}

purge_orphan_syncs() {
  echo "==> orphaned sync_repo_to_handout jobs for ${ORG}/fa26-handout-p1-shell"
  psql_prod -v template_repo="${ORG}/fa26-handout-p1-shell" <<'SQL'
\timing on
begin;
set local lock_timeout = '5s';
create temp table orphans on commit drop as
select q.msg_id, q.read_ct, q.vt > now() as in_flight, q.message->'args'->>'repository_full_name' as repo
  from pgmq.q_async_calls q
 where q.message->>'method' = 'sync_repo_to_handout'
   and q.message->'args'->>'template_repo' = :'template_repo'
   and not exists (select 1 from public.repositories r
                    where r.id = (q.message->'args'->>'repository_id')::bigint);
select count(*) as orphans, count(*) filter (where in_flight) as in_flight,
       max(read_ct) as max_read_ct, min(msg_id), max(msg_id)
  from orphans;
select count(*) as deleted
  from pgmq.delete('async_calls', (select coalesce(array_agg(msg_id), '{}') from orphans));
\echo '-- remaining sync_repo_to_handout jobs for this handout (expect 0)'
select count(*) from pgmq.q_async_calls q
 where q.message->>'method' = 'sync_repo_to_handout'
   and q.message->'args'->>'template_repo' = :'template_repo';
commit;
SQL
}

case "$mode" in
  check)   check ;;
  purge-orphan-syncs)
    read -r -p "Delete orphaned sync_repo_to_handout jobs for assignment ${ASSIGNMENT_ID} in ${NAMESPACE}? type 'purge': " ok
    [ "$ok" = "purge" ] || { echo "aborted" >&2; exit 1; }
    purge_orphan_syncs
    ;;
  dry-run) run_txn rollback ;;
  apply)
    read -r -p "COMMIT the delete of assignment ${ASSIGNMENT_ID} in ${NAMESPACE}? type 'delete ${ASSIGNMENT_ID}': " ok
    [ "$ok" = "delete ${ASSIGNMENT_ID}" ] || { echo "aborted" >&2; exit 1; }
    run_txn commit
    ;;
esac
