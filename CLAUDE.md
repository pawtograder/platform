# Pawtograder Platform - Claude Code Guide

A Next.js course operations platform with Supabase backend (auth, database, storage, edge functions).

## Quick Reference Commands

```bash
# Build & Verify
npm run build                    # Build the application (required before E2E tests)
npm run lint                     # Run ESLint + Prettier checks

# Testing
npm run test                     # Run Jest unit tests
npm run test:e2e                 # Run Playwright E2E tests (requires local Supabase + build)
npx playwright test --ui         # Interactive Playwright UI

# Type Generation
npm run client-local             # Regenerate Supabase types from local dev DB after migrations
```

## Local Supabase Development

### Check Status

```bash
# Check if Supabase containers are running
docker ps --format '{{.Names}}' | grep supabase

# If running, get connection info
npx supabase status
```

### Start Local Supabase

```bash
# Start all Supabase services (requires Docker)
npx supabase start

# Apply migrations and seed data
npx supabase db reset

# Start edge functions (separate terminal)
npx supabase functions serve
```

### Local Service URLs (when running)

| Service | URL |
|---------|-----|
| API | http://127.0.0.1:54321 |
| Studio (DB UI) | http://127.0.0.1:54323 |
| Inbucket (Email) | http://127.0.0.1:54324 |
| Database | postgresql://postgres:postgres@127.0.0.1:54322/postgres |

### Environment Setup for Local Dev

Create `.env.local` with values from `npx supabase status`:

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key from supabase start>
SUPABASE_SERVICE_ROLE_KEY=<service_role key from supabase start>
ENABLE_SIGNUPS=true
```

## Running E2E Tests

E2E tests require the full local stack:

1. **Ensure Supabase is running**: `npx supabase status` (or start with `npx supabase start && npx supabase db reset`)
2. **Build the app**: `npm run build`
3. **Start the server**: `npm start` (in a separate terminal)
4. **Start edge functions**: `npx supabase functions serve` (in another terminal)
5. **Run tests**: `npm run test:e2e`

Tests are in `tests/e2e/` directory.

### Seed Test Data

```bash
npm run seed    # Creates test class with students, assignments, and submissions
```

This prints login credentials for test accounts.

## Schema Changes Workflow

After modifying database schema (migrations):

1. Apply migrations: `npx supabase db reset`
2. Regenerate types: `npm run client-local`
3. Build to verify: `npm run build`

## Project Structure

- `/app/` - Next.js app router pages
- `/components/` - React components
- `/utils/supabase/` - Supabase client utilities and generated types
- `/supabase/migrations/` - Database migrations (50+)
- `/supabase/functions/` - Supabase Edge Functions (48+ Deno functions)
- `/supabase/seed.sql` - Database seed data
- `/tests/e2e/` - Playwright E2E tests (20+)
- `/scripts/` - Utility scripts (seeding, audits)

## Common Development Tasks

### Verify Changes Work

```bash
npm run build && npm run lint
```

### After Making Schema/Migration Changes

```bash
npx supabase db reset && npm run client-local && npm run build
```

### Full E2E Test Run

```bash
# Terminal 1: Ensure Supabase is running
npx supabase status || (npx supabase start && npx supabase db reset)

# Terminal 2: Edge functions
npx supabase functions serve

# Terminal 3: Build and serve app
npm run build && npm start

# Terminal 4: Run tests
npm run test:e2e
```

## Notes

- Build uses `NODE_OPTIONS=--max-old-space-size=8000` for memory
- E2E tests run on Chromium and WebKit (not Firefox)
- Tests use 4 parallel workers, 60s timeout per test
- Edge functions are Deno/TypeScript
