# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Setup, Commands, and Local Dev

See [AGENTS.md](./AGENTS.md) for build/test/lint commands, local Supabase setup, seeding, ports, and known issues. Everything there applies here too.

Additional commands not in AGENTS.md:
```bash
npm run client-local          # Regenerate TS types from local Supabase schema
npm run client                # Regenerate TS types from remote staging schema
npm run typecheck:functions   # Deno type-check Edge Functions
npx jest path/to/test.ts      # Run a single Jest test
npx playwright test path.spec.ts  # Run a single Playwright test
```

## Architecture

### Supabase Client Patterns

Two typed client factories (both use generated `Database` type from `utils/supabase/SupabaseTypes.d.ts`):
- `utils/supabase/server.ts` — server-side client using Next.js cookies (Server Components, Route Handlers)
- `utils/supabase/client.ts` — browser client with Realtime worker; also exports `createAdminClient` using service role key (server-only)

### Edge Functions (`supabase/functions/`)

~49 Deno Edge Functions for GitHub webhook processing, autograder workflows, group management, enrollment sync, Discord, notifications, metrics. Shared types in `supabase/functions/_shared/FunctionTypes.ts`. Frontend invokes them via `supabase.functions.invoke()` — wrapper functions in `lib/edgeFunctions.ts`.

### Realtime Controllers (`lib/`)

Stateful classes managing Supabase Realtime subscriptions, consumed by hooks in `hooks/`:
- `ClassRealTimeController` — class-wide updates
- `OfficeHoursRealTimeController` — help queue
- `DiscussionThreadRealTimeController` — discussion threads
- `RealtimeChannelManager` — low-level channel management
- `PawtograderRealTimeController` — base class

### Frontend Routes (`app/`)

Next.js App Router:
- `(auth-pages)/` — login/signup
- `course/[course_id]/` — student-facing (assignments, office hours, discussion, gradebook)
- `course/[course_id]/manage/` — instructor management views
- `api/` — API routes (Discord webhooks/OAuth, LLM hints, calendar export)
- `admin/` — platform admin dashboard

### Generated Types

`utils/supabase/SupabaseTypes.d.ts` is auto-generated and copied to `supabase/functions/_shared/`. After schema changes, run `npm run client-local`. Do not hand-edit.

### Data Access: Prefer Postgres RPCs

Prefer Postgres RPCs (`supabase.rpc(...)`) over Next.js server actions or Supabase Edge Functions for data operations. Edge Functions are for integrations that need external APIs (GitHub, Discord, AWS Chime, etc.), not general data access.

### TableController Pattern (`lib/TableController.ts`)

The `TableController` class manages data caching and loading, scoped to a context (course, assignment, submission, discussion thread, etc.). Components consume data through these controllers rather than making direct Supabase queries. Realtime controllers extend this pattern for live updates.

### Key Conventions

- `@/*` path alias maps to project root.
- Copy `.env.local.staging` to `.env.local` for frontend-only dev against staging. Signups disabled on staging; use local Supabase for full dev.
- Seeded test users have password `change-it`. Include "instructor" in email for instructor role.
