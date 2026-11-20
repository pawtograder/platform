// Storage reads shared by the exam worker's handlers.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Database } from "../_shared/SupabaseTypes.d.ts";

type Admin = SupabaseClient<Database>;

export async function downloadImage(admin: Admin, bucket: string, path: string): Promise<Uint8Array> {
  const { data, error } = await admin.storage.from(bucket).download(path);
  if (error || !data) throw new Error(`download ${bucket}/${path} failed: ${error?.message}`);
  return new Uint8Array(await data.arrayBuffer());
}

// Download an image at most once per cache. Lets a single doMatch group / finalize pass
// reuse the same page bytes (e.g. SIS-id and name regions on one page, or a page that is
// both copied to submission-files and read for answer structuring) instead of re-fetching.
// Caches the in-flight promise so even concurrent reads of one path share a single fetch.
export function downloadImageCached(
  admin: Admin,
  cache: Map<string, Promise<Uint8Array>>,
  bucket: string,
  path: string
): Promise<Uint8Array> {
  let pending = cache.get(path);
  if (!pending) {
    pending = downloadImage(admin, bucket, path);
    cache.set(path, pending);
  }
  return pending;
}
