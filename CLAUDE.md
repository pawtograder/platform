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

### Data Layer: TanStack Query + Cross-Tab Realtime Bridge

Data flows through TanStack Query (`@tanstack/react-query` v5) with a custom cross-tab leader election system. One browser tab owns the Supabase Realtime WebSocket connection; follower tabs receive surgical cache diffs via `BroadcastChannel`.

**Infrastructure (`lib/cross-tab/`):**

- `TabLeaderElection` — heartbeat-based leader election (3s heartbeat, 5s dead-leader timeout, lowest tabId tiebreak)
- `RealtimeDiffChannel` — broadcasts `{ queryKey, operations: [{type, rows}] }` diffs between tabs
- `useRealtimeBridge` — React hook connecting leader election, RT subscriptions, and diff channel
- `createRealtimeBatchHandler` — pure function processing RT broadcast messages into cache operations
- `LeaderProvider` — React context providing election + diff channel to the component tree

**Generic hooks (`hooks/`):**

- `useSupabaseRealtimeQuery` — drop-in replacement for `TableController`; combines `useQuery` with `useRealtimeBridge`. Defaults `staleTime: Infinity` since the bridge manages freshness.
- `useSupabaseRealtimeMutation` — wraps `useMutation` with optimistic updates, rollback, and cache invalidation

**Domain-specific hooks (per-domain directories):**

- `hooks/course-data/` — ~30 hooks for all course-scoped tables (profiles, tags, assignments, discussions, labs, surveys, etc.)
- `hooks/assignment-data/` — ~15 hooks for assignment-scoped tables (rubrics, submissions, reviews, leaderboard, error pins)
- `hooks/office-hours-data/` — ~16 hooks for help queue tables, including dynamic per-request hooks with `gcTime: 5min` for automatic memory cleanup
- `hooks/submission-data/` — ~10 hooks for submission-scoped tables (comments, reviews, artifacts) with `scope: 'scoped'` RT
- `hooks/discussion-data/` — per-thread discussion hooks

**Bridge components (coexistence layer):**

During migration, bridge components (`CourseDataBridge`, `AssignmentDataBridge`, `OfficeHoursDataBridge`, `SubmissionDataBridge`) read from the legacy controllers and provide values to the new `*DataProvider` contexts. These are mounted in the layout files alongside the old providers.

**Provider nesting (in `components/ui/provider.tsx`):**

```
ChakraProvider > QueryClientProvider > LeaderProvider > Refine > ColorModeProvider
```

**When writing new data hooks:** Use `useSupabaseRealtimeQuery` from `@/hooks/useSupabaseRealtimeQuery` with the appropriate `*DataContext`. Do NOT create new `TableController` instances.

### Realtime Controllers (`lib/`) — Legacy, Being Replaced

Stateful classes managing Supabase Realtime subscriptions. These are still instantiated but data now flows through TanStack Query hooks above. The controllers exist to provide `classRtc` to the bridge components.

- `ClassRealTimeController` — class-wide updates (staff, students, user channels)
- `OfficeHoursRealTimeController` — help queue channels
- `DiscussionThreadRealTimeController` — per-thread channels
- `RealtimeChannelManager` — low-level channel management
- `PawtograderRealTimeController` — interface implemented by all controllers

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

### TableController Pattern (`lib/TableController.ts`) — Legacy

The `TableController` class (2,658 lines) is the old data layer. Wrapper hooks in `useCourseController.tsx`, `useAssignment.tsx`, `useOfficeHoursRealtime.tsx` have been **shimmed** to call TanStack Query hooks internally — the class still exists but data flows through TanStack Query. Do NOT add new `TableController` instances; use `useSupabaseRealtimeQuery` instead.

### Key Conventions

- `@/*` path alias maps to project root.
- Copy `.env.local.staging` to `.env.local` for frontend-only dev against staging. Signups disabled on staging; use local Supabase for full dev.
- Seeded test users have password `change-it`. Include "instructor" in email for instructor role.
