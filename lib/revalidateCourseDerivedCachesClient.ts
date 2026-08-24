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
 * @param tables Class-scoped tables the write touched. Omit to fall back to the whole
 *   class-scoped set, which is correct but evicts more than necessary.
 */
export async function revalidateCourseDerivedCachesClient(
  classId: number,
  tables?: readonly ClassScopedCachedTable[]
): Promise<void> {
  try {
    const res = await fetch("/api/cache/revalidate-tags", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tables ? { classId, tables } : { classId })
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
