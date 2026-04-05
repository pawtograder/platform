/**
 * POSTs to `/api/cache/revalidate-tags` with `{ classId }` using the session cookie.
 * Best-effort: logs warnings on failure; does not throw.
 */
export async function revalidateCourseDerivedCachesClient(classId: number): Promise<void> {
  try {
    const res = await fetch("/api/cache/revalidate-tags", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classId })
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
