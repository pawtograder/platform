# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Pawtograder is a Next.js 15 + Supabase course operations platform (autograder, hand-grading, office hours, Q&A, gradebook). The codebase is a single Next.js application backed by a local Supabase instance (PostgreSQL, Auth, Realtime, Storage, Edge Functions) running in Docker.

### Starting services

1. **Docker daemon**: `sudo dockerd &>/tmp/dockerd.log &` — wait a few seconds, then verify with `docker info`.
2. **Supabase**: `npx supabase start` — starts all Supabase services in Docker. Output includes local API URL and keys.
   - **Known issue**: Migration `20260217000000_binary_submission_files.sql` may fail with `must be owner of table objects` because it creates RLS policies on `storage.objects`. Workaround: temporarily move the migration file, run `supabase start`, apply it via `docker exec -i supabase_db_pawtograder-platform psql -U postgres -d postgres < <migration_file>`, record it in `supabase_migrations.schema_migrations`, then restore the file.
3. **Configure `.env.local`**: After `supabase start`, get keys with `npx supabase status -o env` and set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `NEXT_PUBLIC_PAWTOGRADER_WEB_URL=http://localhost:3000`, and `ENABLE_SIGNUPS=true`.
4. **Next.js dev server**: `npm run dev` — serves at `http://localhost:3000`.

### Seeding the database

Run `npm run seed` to create a test class with students, assignments, and login credentials. The output includes instructor/grader/student emails (all with password `change-it`). The instructor dashboard is at `/course/<class_id>`.

### Lint / Test / Build

- **Lint**: `npm run lint` (ESLint + Prettier). See `package.json` scripts.
- **Unit tests**: `npm test` (Jest). Note: `jest.setup.ts` must exist (import `@testing-library/jest-dom`). The existing test has a pre-existing issue with `Request` not being defined in jsdom.
- **E2E tests**: `npm run test:e2e:local` — this sets `BASE_URL=http://localhost:3000` and runs Playwright. Requires local Supabase running + dev server at port 3000. Also needs `SUPABASE_URL` and `SUPABASE_ANON_KEY` exported (or in `.env.local`), since `TestingUtils.ts` reads them from `process.env`. Tests run against chromium and webkit.
- **Build**: `npm run build` (requires ~8 GB memory via `NODE_OPTIONS=--max-old-space-size=8000`).
- **Format**: `npm run format` (Prettier auto-fix).

### Key ports

| Service | Port |
|---------|------|
| Next.js dev server | 3000 |
| Supabase API | 54321 |
| Supabase DB (PostgreSQL) | 54322 |
| Supabase Studio | 54323 |
| Mailpit (email testing) | 54324 |

### Notes

- The staging Supabase backend (`.env.local.staging`) has signups disabled; use local Supabase for full dev.
- Docker in this cloud VM requires `fuse-overlayfs` storage driver and `iptables-legacy`. These are configured during initial setup.
- Edge Functions (`npx supabase functions serve`) are optional unless you need webhook/autograder/notification processing locally.
