import { getOctoKit } from "../_shared/GitHubWrapper.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";
import Bottleneck from "https://esm.sh/bottleneck?target=deno";

interface Cache {
  id: number;
  key: string;
  ref: string;
  size_in_bytes: number;
  created_at: string;
  last_accessed_at: string;
}

interface CachesResponse {
  total_count: number;
  actions_caches: Cache[];
}

/**
 * Lists all caches for a repository
 */
async function listCachesForRepo(org: string, repo: string, scope?: Sentry.Scope): Promise<Cache[]> {
  const octokit = await getOctoKit(org, scope);
  if (!octokit) {
    throw new Error(`No octokit found for organization ${org}`);
  }

  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/actions/caches", {
      owner: org,
      repo,
      per_page: 100
    });

    const data = response.data as CachesResponse;
    return data.actions_caches || [];
  } catch (error: unknown) {
    if (error && typeof error === "object" && "status" in error && error.status === 404) {
      // eslint-disable-next-line no-console
      console.log(`  No caches found or actions not enabled for ${org}/${repo}`);
      return [];
    }
    throw error;
  }
}

/**
 * Deletes a specific cache by ID
 */
async function deleteCache(org: string, repo: string, cacheId: number, scope?: Sentry.Scope): Promise<void> {
  const octokit = await getOctoKit(org, scope);
  if (!octokit) {
    throw new Error(`No octokit found for organization ${org}`);
  }

  await octokit.request("DELETE /repos/{owner}/{repo}/actions/caches/{cache_id}", {
    owner: org,
    repo,
    cache_id: cacheId
  });
}

/**
 * Process a single repository and delete all its caches
 */
async function processRepository(
  fullName: string,
  scope: Sentry.Scope
): Promise<{ cachesDeleted: number; sizeFreed: number }> {
  if (!fullName || !fullName.includes("/")) {
    // eslint-disable-next-line no-console
    console.log(`⚠️  Skipping invalid repository name: ${fullName}\n`);
    return { cachesDeleted: 0, sizeFreed: 0 };
  }

  const [org, repoName] = fullName.split("/");
  // eslint-disable-next-line no-console
  console.log(`📦 Checking ${fullName}...`);

  try {
    // List all caches for this repo
    const caches = await listCachesForRepo(org, repoName, scope);

    if (caches.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`  ✓ No caches found\n`);
      return { cachesDeleted: 0, sizeFreed: 0 };
    }

    // eslint-disable-next-line no-console
    console.log(`  Found ${caches.length} cache(s)`);

    let cachesDeleted = 0;
    let sizeFreed = 0;

    // Delete each cache
    for (const cache of caches) {
      try {
        const sizeMB = (cache.size_in_bytes / (1024 * 1024)).toFixed(2);
        // eslint-disable-next-line no-console
        console.log(`  🗑️  Deleting cache: ${cache.key} (${sizeMB} MB)`);

        await deleteCache(org, repoName, cache.id, scope);
        cachesDeleted++;
        sizeFreed += cache.size_in_bytes;

        // eslint-disable-next-line no-console
        console.log(`  ✓ Deleted cache ID ${cache.id}`);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // eslint-disable-next-line no-console
        console.error(`  ✗ Failed to delete cache ${cache.id}: ${errorMessage}`);
        Sentry.captureException(error, scope);
      }
    }

    // eslint-disable-next-line no-console
    console.log("");
    return { cachesDeleted, sizeFreed };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(`  ✗ Error processing ${fullName}: ${errorMessage}\n`);
    Sentry.captureException(error, scope);
    return { cachesDeleted: 0, sizeFreed: 0 };
  }
}

/**
 * Main function to clear all caches for repositories matching a prefix
 */
async function clearCachesForRepos(repoPrefix: string) {
  // eslint-disable-next-line no-console
  console.log(`\n🔍 Finding all repositories matching prefix: ${repoPrefix}\n`);

  const scope = new Sentry.Scope();
  scope.setTag("operation", "clear_caches");
  scope.setTag("repo_prefix", repoPrefix);

  // Create Supabase client
  const supabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  // Query repositories with LIKE pattern
  const { data: repos, error } = await supabase
    .from("repositories")
    .select("repository")
    .like("repository", `${repoPrefix}%`);

  if (error) {
    throw new Error(`Failed to query repositories: ${error.message}`);
  }

  if (!repos || repos.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`No repositories found matching prefix: ${repoPrefix}`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`Found ${repos.length} repositories matching prefix`);
  // eslint-disable-next-line no-console
  console.log(`Processing up to 10 repositories in parallel...\n`);

  // Create Bottleneck limiter for parallel processing
  const limiter = new Bottleneck({
    maxConcurrent: 10,
    minTime: 0
  });

  // Process repositories in parallel with concurrency limit
  const results = await Promise.all(
    repos.map((repo) =>
      limiter.schedule(() => processRepository(repo.repository, scope))
    )
  );

  // Sum up the results
  const totalCachesDeleted = results.reduce((sum, r) => sum + r.cachesDeleted, 0);
  const totalSizeFreed = results.reduce((sum, r) => sum + r.sizeFreed, 0);

  const totalSizeMB = (totalSizeFreed / (1024 * 1024)).toFixed(2);
  const totalSizeGB = (totalSizeFreed / (1024 * 1024 * 1024)).toFixed(2);

  // eslint-disable-next-line no-console
  console.log(`\n✅ Summary:`);
  // eslint-disable-next-line no-console
  console.log(`   Total repositories processed: ${repos.length}`);
  // eslint-disable-next-line no-console
  console.log(`   Total caches deleted: ${totalCachesDeleted}`);
  // eslint-disable-next-line no-console
  console.log(`   Total space freed: ${totalSizeMB} MB (${totalSizeGB} GB)`);
  // eslint-disable-next-line no-console
  console.log("");
}

// Main execution
if (import.meta.main) {
  const repoPrefix = Deno.args[0];

  if (!repoPrefix) {
    // eslint-disable-next-line no-console
    console.error("Usage: deno run --allow-all ClearCaches.ts <repo-prefix>");
    // eslint-disable-next-line no-console
    console.error("\nExample:");
    // eslint-disable-next-line no-console
    console.error("  deno run --allow-all ClearCaches.ts NEU-CS2510-SP25/");
    // eslint-disable-next-line no-console
    console.error("  deno run --allow-all ClearCaches.ts NEU-CS2510-SP25/student-");
    Deno.exit(1);
  }

  try {
    await clearCachesForRepos(repoPrefix);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(`\n❌ Fatal error: ${errorMessage}`);
    Sentry.captureException(error);
    Deno.exit(1);
  }
}

