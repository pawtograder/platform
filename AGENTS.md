# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Pawtograder is a Next.js 15 + Supabase course operations platform (autograder, hand-grading, office hours, Q&A, gradebook). The codebase is a single Next.js application backed by a local Supabase instance (PostgreSQL, Auth, Realtime, Storage, Edge Functions) running in Docker.

### Starting services

1. **Docker daemon**: `sudo dockerd &>/tmp/dockerd.log &` — wait a few seconds, then verify with `docker info`.
2. **Supabase**: `npx supabase start` — starts all Supabase services in Docker. Output includes local API URL and keys.
   - **Known issue**: Migration `20260217000000_binary_submission_files.sql` may fail with `must be owner of table objects` because it creates RLS policies on `storage.objects`. Workaround: temporarily move the migration file, run `supabase start`, apply it via `docker exec -i supabase_db_pawtograder-platform psql -U postgres -d postgres < <migration_file>`, record it in `supabase_migrations.schema_migrations`, then restore the file.
3. **Configure `.env.local`**: After `supabase start`, get keys with `npx supabase status -o env` and set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `NEXT_PUBLIC_PAWTOGRADER_WEB_URL=http://localhost:3000`, and `ENABLE_SIGNUPS=true`.
   - **Prod E2E on port 3001**: Next.js inlines `NEXT_PUBLIC_*` at **build** time. Set `NEXT_PUBLIC_PAWTOGRADER_WEB_URL=http://localhost:3001` for `npm run build` (and keep it in `.env.local` while iterating) so auth redirects and magic links match `BASE_URL` / `PORT`; exporting it only when running Playwright does not change an existing bundle.
4. **Edge Functions (recommended for local E2E/prod-mode testing)**: `npx supabase functions serve --env-file .env.local` — serves local functions at `http://127.0.0.1:54321/functions/v1/*`.
   - Required when testing flows that invoke `autograder-create-submission`, `autograder-submit-feedback`, webhooks, or async workers.
5. **Next.js dev server**: `npm run dev` — serves at `http://localhost:3000`.

### Seeding the database

Run `npm run seed` to create a test class with students, assignments, and login credentials. The output includes instructor/grader/student emails (all with password `change-it`). The instructor dashboard is at `/course/<class_id>`.

### Before committing

**Always** run `npm run format` before committing. This runs Prettier on the entire codebase. CI will reject unformatted code.

### Lint / Test / Build

- **Lint**: `npm run lint` (ESLint + Prettier). See `package.json` scripts.
- **Unit tests**: `npm test` (Jest). Note: `jest.setup.ts` must exist (import `@testing-library/jest-dom`). The existing test has a pre-existing issue with `Request` not being defined in jsdom.
- **E2E — local (recommended default for everyday dev)**: With local Supabase running and `npm run dev` (port 3000), run **`npm run test:e2e:local`** — it sets `BASE_URL=http://localhost:3000` to match the dev server (`playwright.config.ts`). Ensure **`SUPABASE_URL`**, **`SUPABASE_ANON_KEY`**, and **`SUPABASE_SERVICE_ROLE_KEY`** are in `.env.local` or exported: `tests/e2e/TestingUtils.ts` loads `.env.local` via dotenv and uses those values (plus the service role for the admin client) for setup and auth helpers.
- **E2E — prod build (CI-like, fewer timing flakes)**: Prefer a production build/server over `next dev` when debugging flakes or matching CI.
  - Never run `next dev` and `next start` at the same time in this environment. Stop all dev servers before prod E2E runs.
  - Build from a clean output directory with the public web URL matching the prod server port (see note above on **`NEXT_PUBLIC_PAWTOGRADER_WEB_URL` at build time**): `export NEXT_PUBLIC_PAWTOGRADER_WEB_URL=http://localhost:3001 && rm -rf .next && npm run build`
  - Start only the prod server: `PORT=3001 npm run start`
  - Run Playwright with matching **`BASE_URL`**: `BASE_URL=http://localhost:3001 npx playwright test ...` (the **built** app URL comes from the build step above; Playwright only needs `BASE_URL` to match where `next start` listens).
  - If a test is flaky in dev mode, switch back to prod-build runs immediately.
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
