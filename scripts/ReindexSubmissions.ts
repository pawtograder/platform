/* eslint-disable no-console */
/**
 * Backfill / re-index the code-symbol index for existing submissions.
 *
 * Symbol indexing runs automatically as new submissions are ingested. This script reindexes
 * submissions that predate the feature (or whose parser output should be refreshed after the parser
 * evolves) by invoking the same `index-submission` edge function used at ingestion — one indexing
 * implementation, two callers.
 *
 * Usage:
 *   npx tsx scripts/ReindexSubmissions.ts [--class <id>] [--assignment <id>] [--limit <n>] [--concurrency <n>]
 *
 * Requires a service-role environment (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local) and
 * the index-submission edge function deployed/served for the target environment.
 */
import { indexSubmission } from "@/lib/edgeFunctions";
import { createAdminClient } from "@/utils/supabase/client";
import { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

function parseArgs(argv: string[]) {
  const opts: { class?: number; assignment?: number; limit?: number; concurrency: number } = { concurrency: 5 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case "--class":
        opts.class = Number(value);
        i++;
        break;
      case "--assignment":
        opts.assignment = Number(value);
        i++;
        break;
      case "--limit":
        opts.limit = Number(value);
        i++;
        break;
      case "--concurrency":
        opts.concurrency = Math.max(1, Number(value));
        i++;
        break;
      default:
        break;
    }
  }
  return opts;
}

/** Run `worker` over `items` with at most `concurrency` in flight. */
async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const supabase = createAdminClient<Database>();

  // Page through submission ids (oldest first) so a large backfill streams in stable order.
  const PAGE = 1000;
  const submissionIds: number[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = supabase
      .from("submissions")
      .select("id")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (opts.class !== undefined) query = query.eq("class_id", opts.class);
    if (opts.assignment !== undefined) query = query.eq("assignment_id", opts.assignment);
    const { data, error } = await query;
    if (error) throw new Error(`Failed to list submissions: ${error.message}`);
    if (!data || data.length === 0) break;
    submissionIds.push(...data.map((r) => r.id));
    if (data.length < PAGE) break;
    if (opts.limit !== undefined && submissionIds.length >= opts.limit) break;
  }

  const targets = opts.limit !== undefined ? submissionIds.slice(0, opts.limit) : submissionIds;
  console.log(`Reindexing ${targets.length} submission(s) with concurrency ${opts.concurrency}...`);

  let done = 0;
  let failed = 0;
  let totalIndexed = 0;
  await runPool(targets, opts.concurrency, async (submission_id) => {
    try {
      const { indexed } = await indexSubmission({ submission_id }, supabase);
      totalIndexed += indexed;
    } catch (err) {
      failed++;
      console.error(`  submission ${submission_id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    done++;
    if (done % 50 === 0 || done === targets.length) {
      console.log(`  ${done}/${targets.length} processed (${totalIndexed} files indexed, ${failed} failed)`);
    }
  });

  console.log(
    `Done. Indexed ${totalIndexed} file(s) across ${targets.length - failed} submission(s); ${failed} failed.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
