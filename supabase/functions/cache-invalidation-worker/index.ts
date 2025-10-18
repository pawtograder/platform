import { createClient } from "jsr:@supabase/supabase-js@2";
import { Database } from "../_shared/SupabaseTypes.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient<Database>(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const vercelDeploymentUrl = Deno.env.get("VERCEL_DEPLOYMENT_URL");
    const revalidationSecret = Deno.env.get("REVALIDATION_SECRET");

    if (!vercelDeploymentUrl || !revalidationSecret) {
      console.error("Missing environment variables: VERCEL_DEPLOYMENT_URL or REVALIDATION_SECRET");
      return new Response(
        JSON.stringify({ error: "Worker not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch pending invalidations (buckets ready to process)
    // Only process buckets older than 5 seconds to ensure debouncing window has passed
    const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString();

    const { data: pending, error: fetchError } = await supabase
      .from("cache_invalidation_queue")
      .select("tag, time_bucket, invalidation_count")
      .or(`last_invalidated_at.is.null,last_invalidated_at.lt.time_bucket`)
      .lt("time_bucket", fiveSecondsAgo)
      .order("time_bucket", { ascending: true })
      .limit(100);

    if (fetchError) {
      console.error("Error fetching pending invalidations:", fetchError);
      return new Response(
        JSON.stringify({ error: "Database query failed", details: fetchError }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!pending || pending.length === 0) {
      return new Response(
        JSON.stringify({ message: "No invalidations pending", processed: 0 }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Group by tag to batch Vercel API calls (multiple buckets for same tag = 1 invalidation)
    const tagMap = new Map<string, { count: number; buckets: string[] }>();
    for (const item of pending) {
      const existing = tagMap.get(item.tag) || { count: 0, buckets: [] };
      existing.count += item.invalidation_count || 1;
      existing.buckets.push(item.time_bucket);
      tagMap.set(item.tag, existing);
    }

    console.log(`Processing ${tagMap.size} unique tags from ${pending.length} time buckets`);

    // Call Vercel revalidateTag API for each unique tag
    const results = await Promise.allSettled(
      Array.from(tagMap.entries()).map(async ([tag, info]) => {
        console.log(`Invalidating tag: ${tag} (${info.count} updates across ${info.buckets.length} buckets)`);

        const response = await fetch(`${vercelDeploymentUrl}/api/revalidate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-revalidation-secret": revalidationSecret
          },
          body: JSON.stringify({ tag })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Revalidation failed for ${tag}: ${response.status} ${errorText}`);
        }

        return { tag, status: "success" };
      })
    );

    // Mark processed invalidations
    const now = new Date().toISOString();
    const allTags = Array.from(tagMap.keys());
    const allBuckets = Array.from(tagMap.values()).flatMap((info) => info.buckets);

    const { error: updateError } = await supabase
      .from("cache_invalidation_queue")
      .update({ last_invalidated_at: now })
      .in("tag", allTags)
      .in("time_bucket", allBuckets);

    if (updateError) {
      console.error("Error marking invalidations as processed:", updateError);
    }

    // Cleanup old processed rows (>1 hour old and already invalidated)
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const { error: cleanupError, count: deletedCount } = await supabase
      .from("cache_invalidation_queue")
      .delete()
      .lt("created_at", oneHourAgo)
      .not("last_invalidated_at", "is", null);

    if (cleanupError) {
      console.error("Error during cleanup:", cleanupError);
    } else if (deletedCount && deletedCount > 0) {
      console.log(`Cleaned up ${deletedCount} old invalidation records`);
    }

    // Count successes and failures
    const successful = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    const failedResults = results
      .filter((r) => r.status === "rejected")
      .map((r) => (r as PromiseRejectedResult).reason?.message || "Unknown error");

    return new Response(
      JSON.stringify({
        processed: tagMap.size,
        successful,
        failed,
        errors: failed > 0 ? failedResults : undefined,
        cleanedUp: deletedCount || 0,
        timestamp: now
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  } catch (error) {
    console.error("Worker error:", error);
    return new Response(
      JSON.stringify({
        error: "Worker failed",
        message: error instanceof Error ? error.message : "Unknown error"
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
});

