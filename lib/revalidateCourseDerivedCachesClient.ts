/**
 * Call after client-side mutations that should drop Next.js unstable_cache entries
 * for course-scoped dashboards and lists (see `courseDerivedDataTags`).
 */
export async function revalidateCourseDerivedCachesClient(classId: number): Promise<void> {
  try {
    await fetch("/api/cache/revalidate-tags", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classId })
    });
  } catch {
    // Non-fatal: TTL and DB triggers still refresh caches eventually
  }
}
