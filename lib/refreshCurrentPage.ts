"use server";

import { cookies } from "next/headers";

/**
 * Re-renders the calling page's Server Components, like `router.refresh()`, but its failure can be
 * caught. `router.refresh()` turns any failed fetch into a hard navigation, which replaces the page
 * with the browser's error page in Chromium and leaves WebKit's router suspended. An action that
 * fails before its response's root row arrives only rejects its promise and leaves the router alone.
 * A response cut after that row is different: Next has started rendering it, and the missing rows send
 * the page to `app/global-error.tsx`. `router.refresh()` and a link click do the same.
 *
 * Next re-renders the page when an action changes a cookie. This deletes one that is never set, so
 * it stores nothing. `revalidatePath()` would re-render too, but that re-render would skip the server
 * fetch cache on every tab switch.
 *
 * `router.refresh()` also compares builds and reloads a tab a deploy left behind, and an action
 * doesn't, so this compares them itself. On a mismatch it returns false with no cookie changed, so
 * no tree comes back: a tree from another build can name client modules this tab doesn't have. A
 * build with no SHA matches any other with none, so it relies on `app/global-error.tsx` for that.
 *
 * Its one input is only compared, and it reads no data. The re-render is the page's own, with the
 * caller's session, so it returns what a GET of that URL would.
 */
export async function refreshCurrentPage(clientBuild: string | undefined): Promise<boolean> {
  if (clientBuild !== process.env.NEXT_PUBLIC_GIT_COMMIT_SHA) return false;
  (await cookies()).delete("refresh-current-page");
  return true;
}
