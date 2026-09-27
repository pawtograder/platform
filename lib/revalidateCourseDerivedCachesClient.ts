import type { ClassScopedCachedTable } from "@/lib/next-cache-tags";

/**
 * POSTs to `/api/cache/revalidate-tags` with `{ classId, tables }` using the session cookie.
 * Best-effort: logs warnings on failure; does not throw.
 *
 * This clears the *server* fetch cache only. The browser's Router Cache holds the RSC payload
 * of every segment visited this session and is untouched by `revalidateTag()` — callers that
 * navigate back to a server-rendered view must also `router.refresh()`. Use
 * `useRevalidateServerCaches()` (hooks/useRevalidateServerCaches.ts) rather than calling this
 * directly, so both halves happen in the right order.
 *
 * Callers await this before navigating, so it is deliberately bounded: an unreachable or slow
 * endpoint (or a stalled Redis-backed cache handler) must not strand the user on the form they
 * just submitted. On timeout we give up on the server-cache half and let the caller proceed —
 * the Router Cache refresh, which is the part issue #937 was actually about, still happens, and
 * the Postgres triggers invalidate the same tags independently.
 *
 * @param tables Class-scoped tables the write touched. Omit to fall back to the whole
 *   class-scoped set, which is correct but evicts more than necessary.
 */
export const REVALIDATE_TAGS_TIMEOUT_MS = 3000;

export async function revalidateCourseDerivedCachesClient(
  classId: number,
  tables?: readonly ClassScopedCachedTable[]
): Promise<void> {
  try {
    const res = await fetch("/api/cache/revalidate-tags", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tables ? { classId, tables } : { classId }),
      // `AbortSignal.timeout` is guarded rather than assumed: this runs in the browser, and a
      // missing implementation should degrade to the old unbounded behaviour, not throw.
      signal:
        typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(REVALIDATE_TAGS_TIMEOUT_MS)
          : undefined
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console -- operational visibility for cache misses
      console.warn("revalidateCourseDerivedCachesClient: non-ok response", res.status, res.statusText);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("revalidateCourseDerivedCachesClient: request failed", e);
  }
}
