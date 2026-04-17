# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Pawtograder is a Next.js 15 + Supabase course operations platform (autograder, hand-grading, office hours, Q&A, gradebook). The codebase is a single Next.js application backed by a local Supabase instance (PostgreSQL, Auth, Realtime, Storage, Edge Functions) running in Docker.

### Starting services

1. **Docker daemon**: `sudo dockerd &>/tmp/dockerd.log &` — wait a few seconds, then verify with `docker info`. If `docker` commands fail with `permission denied ... /var/run/docker.sock`, prefer the least-privilege fix:
   - Make sure the socket is group-owned by `docker` and add your user to that group, then re-load the group membership for the current shell:
     ```bash
     sudo chown root:docker /var/run/docker.sock
     sudo usermod -aG docker "$USER"
     newgrp docker   # or: log out and back in to pick up the new group
     ```
   - Only as a last-resort temporary workaround on an ephemeral Cloud Agent VM (where the user is already root-equivalent and there is no other tenant on the machine) you may run `sudo chmod 666 /var/run/docker.sock`. **Do not use this on shared or persistent hosts**: it grants every local user full Docker daemon access, which is equivalent to root on the host.
2. **Supabase — ALWAYS START FROM A FRESH DB, NEVER RESTORE A BACKUP**:
   - `npx supabase start` restores from the previously-saved docker volume by default. In a Cloud Agent VM that volume is typically stale (snapshotted at some older schema version) and will be missing dozens of newer migrations — tests then fail with errors like `column ... does not exist`, `no partition of relation "audit" found for row`, or `Could not find the '...' column ... in the schema cache`.
   - **Correct sequence (do this every time before E2E):**
     1. If Supabase is already running, stop it WITHOUT a backup: `npx supabase stop --no-backup` (this deletes the stale volume).
     2. Also delete any leftover project volumes just to be safe: `docker volume ls --filter label=com.supabase.cli.project=pawtograder-platform -q | xargs -r docker volume rm`.
     3. Start fresh: `npx supabase start` — this will run every migration in `supabase/migrations/` against an empty DB.
   - **Known migration issue**: Migration `20260217000000_binary_submission_files.sql` fails during `supabase start` with `must be owner of table objects` because it creates RLS policies on `storage.objects`. Workaround (do this every fresh start):
     1. Before `supabase start`, move the file aside: `mv supabase/migrations/20260217000000_binary_submission_files.sql /tmp/`.
     2. Run `npx supabase start`.
     3. Apply it as superuser: `docker exec -i supabase_db_pawtograder-platform psql -U postgres -d postgres < /tmp/20260217000000_binary_submission_files.sql`.
     4. Record it: `docker exec -i supabase_db_pawtograder-platform psql -U postgres -d postgres -c "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20260217000000', 'binary_submission_files') ON CONFLICT DO NOTHING;"`.
     5. Restore the file: `mv /tmp/20260217000000_binary_submission_files.sql supabase/migrations/`.
   - **Audit partitions**: The partitioned `public.audit` table only has partitions for a narrow date range out of migrations. If the current date is outside that range, inserts fail with `no partition of relation "audit" found for row`. After starting Supabase, run `docker exec -i supabase_db_pawtograder-platform psql -U postgres -d postgres -c "SELECT public.audit_maintain_partitions();"` to create today's partition (and the next 7 days).
   - **Sanity check the schema is current** before running E2E: the newest row of `supabase_migrations.schema_migrations` should match the newest file under `supabase/migrations/` (e.g. `20260413234500`). If it doesn't, the DB was restored from a backup — redo the stop/restart-without-backup sequence above.
3. **Configure `.env.local`**: After `supabase start`, get keys with `npx supabase status -o env` and set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `NEXT_PUBLIC_PAWTOGRADER_WEB_URL=http://localhost:3000`, and `ENABLE_SIGNUPS=true`.
   - **Prod E2E on port 3001**: Next.js inlines `NEXT_PUBLIC_*` at **build** time. Set `NEXT_PUBLIC_PAWTOGRADER_WEB_URL=http://localhost:3001` for `npm run build` (and keep it in `.env.local` while iterating) so auth redirects and magic links match `BASE_URL` / `PORT`; exporting it only when running Playwright does not change an existing bundle.
4. **Edge Functions (recommended for local E2E/prod-mode testing)**: `npx supabase functions serve --env-file .env.local` — serves local functions at `http://127.0.0.1:54321/functions/v1/*`.
   - Required when testing flows that invoke `autograder-create-submission`, `autograder-submit-feedback`, webhooks, or async workers.
5. **Next.js dev server (iterative dev only)**: `npm run dev` — serves at `http://localhost:3000`. Do NOT use `next dev` for E2E runs; use the prod build on port 3001 (see below). `next dev` is dramatically slower per-request and causes widespread Playwright timeouts during full-suite runs.

### Seeding the database

Run `npm run seed` to create a test class with students, assignments, and login credentials. The output includes instructor/grader/student emails (all with password `change-it`). The instructor dashboard is at `/course/<class_id>`.

### Before committing

**Always** run `npm run format` before committing. This runs Prettier on the entire codebase. CI will reject unformatted code.

### Lint / Test / Build

- **Lint**: `npm run lint` (ESLint + Prettier). See `package.json` scripts.
- **Unit tests**: `npm test` (Jest). Note: `jest.setup.ts` must exist (import `@testing-library/jest-dom`). The existing test has a pre-existing issue with `Request` not being defined in jsdom.
- **E2E — prod build (REQUIRED for full-suite runs)**: Always use a production build + `next start` for E2E, not `next dev`. `next dev` in this environment causes widespread Playwright timeouts across the full suite (first-hit compile cost on every route).
  - Never run `next dev` and `next start` at the same time. Stop all dev servers before prod E2E runs.
  - Build from a clean output directory with the public web URL matching the prod server port (see note above on **`NEXT_PUBLIC_PAWTOGRADER_WEB_URL` at build time**): `export NEXT_PUBLIC_PAWTOGRADER_WEB_URL=http://localhost:3001 && rm -rf .next && npm run build`
  - Start only the prod server: `PORT=3001 npm run start`
  - Run Playwright with matching **`BASE_URL`**: `BASE_URL=http://localhost:3001 npx playwright test ...` (the **built** app URL comes from the build step above; Playwright only needs `BASE_URL` to match where `next start` listens).
- **E2E — dev-mode (only for rapid iteration on a single test)**: With local Supabase running and `npm run dev` (port 3000), run **`npm run test:e2e:local`** — it sets `BASE_URL=http://localhost:3000` to match the dev server (`playwright.config.ts`). Ensure **`SUPABASE_URL`**, **`SUPABASE_ANON_KEY`**, and **`SUPABASE_SERVICE_ROLE_KEY`** are in `.env.local` or exported: `tests/e2e/TestingUtils.ts` loads `.env.local` via dotenv and uses those values (plus the service role for the admin client) for setup and auth helpers. Do not use this mode for running the whole suite.
- **Expected E2E failures without real GitHub credentials**: A subset of tests exercise the full `autograder-create-submission` / `autograder-submit-feedback` flow, which clones from `pawtograder-playground/test-e2e-student-repo` via the GitHub App. With dummy `GITHUB_APP_ID=1` / `GITHUB_PRIVATE_KEY_STRING` the first clone fails with `Integration not found`, which trips the org circuit breaker (`public.github_circuit_breakers`) and makes every subsequent call fail fast with `Circuit breaker active`. On a fresh DB these tests will fail locally and are OK to triage as environmental (they pass in CI where real creds are injected). The affected files are primarily `tests/e2e/create-submission.test.tsx` and a handful of dependent tests in `tests/e2e/due-dates.test.tsx`, `emailer.test.tsx`, `survey-assignment-grading.test.tsx`, and the gradebook/enrollment views that need a real submission. If you need to retry after the breaker is open, reset it with: `docker exec -i supabase_db_pawtograder-platform psql -U postgres -d postgres -c "UPDATE public.github_circuit_breakers SET state='closed', open_until=now() WHERE state='open';"`.
- **E2E prerequisites — Edge Functions and secrets**: Several E2E tests invoke Supabase Edge Functions (e.g. `autograder-create-submission`, `autograder-submit-feedback`). For these to work locally:
  1. **Serve Edge Functions**: `npx supabase functions serve --env-file .env.local`
  2. **`.env.local` must contain** (in addition to Supabase keys):
     - `E2E_ENABLE=true` — enables the E2E testing bypass in Edge Functions
     - `END_TO_END_SECRET=not-a-secret` — shared secret between the test runner and Edge Functions
     - `EDGE_FUNCTION_SECRET=some-secret-value` — must match the value stored in the Supabase DB vault (`vault.secrets` table, name `edge-function-secret`). The local Supabase seed sets this to `some-secret-value`.
     - `GITHUB_APP_ID=1` and `GITHUB_PRIVATE_KEY_STRING` (any valid RSA private key) — required for the Edge Function runtime to boot (the GitHub App client initializes at module load). E2E tests bypass GitHub auth, so dummy values work.
  3. **No need to run `npm run seed`** before E2E tests — tests create their own fixtures. Seeding is only needed for manual browser testing.
  4. You can verify Edge Functions are working: `curl http://127.0.0.1:54321/functions/v1/autograder-create-submission` should return `{"error":{"recoverable":false,"message":"No token provided","details":"No token provided"}}` (not `WORKER_ERROR`).
- **Build**: `npm run build` (requires ~8 GB memory via `NODE_OPTIONS=--max-old-space-size=8000`).
- **Format**: `npm run format` (Prettier auto-fix).

### Key ports

| Service                  | Port  |
| ------------------------ | ----- |
| Next.js dev server       | 3000  |
| Supabase API             | 54321 |
| Supabase DB (PostgreSQL) | 54322 |
| Supabase Studio          | 54323 |
| Mailpit (email testing)  | 54324 |

### Notes

- The staging Supabase backend (`.env.local.staging`) has signups disabled; use local Supabase for full dev.
- Docker in this cloud VM requires `fuse-overlayfs` storage driver and `iptables-legacy`. These are configured during initial setup.
- Edge Functions should be started with `.env.local` when needed: `npx supabase functions serve --env-file .env.local`.
