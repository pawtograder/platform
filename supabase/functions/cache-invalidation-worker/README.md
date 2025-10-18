# Cache Invalidation Worker

Background worker that processes the cache invalidation queue and calls Vercel's revalidation API.

## Overview

This worker:
1. Polls `cache_invalidation_queue` table every 10 seconds (via pg_cron)
2. Fetches pending invalidations (time buckets older than 5 seconds)
3. Groups by tag to batch invalidations
4. Calls Vercel `/api/revalidate` endpoint for each unique tag
5. Marks processed invalidations as completed
6. Cleans up old processed records (>1 hour)

## Environment Variables Required

- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key for database access
- `VERCEL_DEPLOYMENT_URL` - Your Vercel deployment URL (e.g., https://your-app.vercel.app)
- `REVALIDATION_SECRET` - Shared secret for revalidation API authentication

## How It Works

### Debouncing (5-second buckets)

Updates are grouped into 5-second time buckets:
- Updates at 10:15:07, 10:15:08, 10:15:09 → all go into bucket 10:15:05
- Worker processes bucket after 5 seconds (at 10:15:10+)
- Result: 3 updates = 1 invalidation API call

### Example Flow

```
T=0s: User updates assignment → trigger enqueues tag 'course_controller:123:staff' in bucket T=0
T=2s: Another update to same course → increments counter in same bucket
T=4s: Third update → increments counter again
T=5s: Bucket closes (new updates go to T=5 bucket)
T=10s: Worker runs, sees bucket T=0 is >5s old
T=10s: Worker calls Vercel API once with tag 'course_controller:123:staff'
T=10s: Worker marks bucket as processed
Result: 3 database updates → 1 Vercel API call (67% reduction!)
```

## Performance

- **Database overhead**: 1 UPSERT per statement (~0.1ms)
- **Queue size**: ~5,000 rows steady state (with cleanup)
- **Latency**: 5-10 seconds from DB update to cache invalidation
- **Batch reduction**: 80-99% fewer API calls vs immediate invalidation

## Monitoring

Check logs in Supabase Edge Functions dashboard:
- "Processing X unique tags from Y time buckets" - normal operation
- "No invalidations pending" - idle state (good)
- Errors - investigate immediately

## Manual Invocation

For testing:
```bash
curl -X POST https://your-project.supabase.co/functions/v1/cache-invalidation-worker \
  -H "Authorization: Bearer YOUR_ANON_KEY"
```

