"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { revalidateCourseDerivedCachesClient } from "@/lib/revalidateCourseDerivedCachesClient";
import type { ClassScopedCachedTable } from "@/lib/next-cache-tags";

/**
 * Run after a client-side write whose result is rendered by a Server Component.
 *
 * Three caches sit between a write and what the user sees, and `revalidateTag()` only reaches
 * one of them:
 *
 *  1. The server fetch cache — `createClientWithCaching()` in `lib/ssrUtils.ts`, keyed by tag
 *     with a 1-hour default TTL. Postgres triggers invalidate it; the
 *     `/api/cache/revalidate-tags` POST below covers writes that race or bypass them.
 *  2. The **client Router Cache** — the browser's copy of the already-rendered RSC payload for
 *     every segment visited this session, held for `experimental.staleTimes.dynamic` (30s, see
 *     `next.config.ts`). Nothing on the server can reach it: `revalidateTag()` evicts the
 *     server's data, not the payload the browser already has. `router.refresh()` is the only
 *     client API that drops it, which is why a manual reload "fixed" issue #937 and a tag
 *     revalidation did not.
 *  3. Client-side `TableController` caches, which heal over Realtime and need nothing here.
 *
 * Two orderings matter, and both are easy to get backwards:
 *
 *  - The tag revalidation is awaited *before* `router.refresh()`. Otherwise the refetch that
 *    `refresh()` kicks off can be served from a server cache entry that is evicted a moment
 *    later, and the user sees pre-write data anyway.
 *  - When the caller is also navigating, pass `navigateTo` instead of calling `router.push()`
 *    afterwards. `router.refresh()` followed by `router.push()` silently does nothing:
 *    dispatching a navigation marks the pending action as discarded so its state is never
 *    applied (`next/dist/client/components/app-router-instance.js`, the `ACTION_NAVIGATE`
 *    branch of `dispatchAction`), and the refresh is exactly that pending action. Pushing
 *    first and refreshing after leaves the refresh queued behind the navigation, where it runs
 *    to completion — and because a refresh rebuilds from the root and resets the prefetch
 *    cache (`refresh-reducer.js`: "router.refresh() has to invalidate the entire cache"), it
 *    drops the stale entry for the list we came from, not just the page we landed on.
 *
 * `classId` is optional so platform-admin views, which read no course-scoped tags, can use the
 * same hook for its Router Cache half.
 */
export function useRevalidateServerCaches(classId?: number): (options?: {
  /** Class-scoped tables the write touched. Omit to evict the whole class-scoped set. */
  tables?: readonly ClassScopedCachedTable[];
  /** Navigate here as part of the revalidation, so the refresh is not discarded. */
  navigateTo?: string;
}) => Promise<void> {
  const router = useRouter();
  return useCallback(
    async ({ tables, navigateTo }: { tables?: readonly ClassScopedCachedTable[]; navigateTo?: string } = {}) => {
      if (typeof classId === "number" && Number.isFinite(classId)) {
        await revalidateCourseDerivedCachesClient(classId, tables);
      }
      if (navigateTo) {
        router.push(navigateTo);
      }
      router.refresh();
    },
    [classId, router]
  );
}
