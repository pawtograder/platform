"use server";

import { cookies } from "next/headers";

/**
 * Re-renders the calling page's Server Components, like `router.refresh()`, but its failure can be
 * caught. `router.refresh()` turns any failed fetch into a hard navigation, which replaces the page
 * with the browser's error page in Chromium and leaves WebKit's router suspended. A failed action
 * only rejects its promise and leaves the router alone.
 *
 * Next re-renders the page when an action changes a cookie. This deletes one that is never set, so
 * it stores nothing. `revalidatePath()` would re-render too, but would also evict the server cache
 * for that path, for every user, on every tab switch.
 *
 * It takes no input and reads no data. The re-render is the page's own, with the caller's session,
 * so it returns what a GET of that URL would.
 */
export async function refreshCurrentPage(): Promise<void> {
  (await cookies()).delete("refresh-current-page");
}
