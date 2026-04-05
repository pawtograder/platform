/* eslint-disable no-console */
/**
 * Approximate server work for course navigation: same PostgREST queries as
 * fetchCourseControllerData / fetchAssignmentControllerData in lib/ssrUtils.ts
 * (service role, paginated in 1000-row chunks).
 *
 * Usage:
 *   npx tsx scripts/BenchmarkCourseSSR.ts --course-id 2
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import type { Database } from "@/utils/supabase/SupabaseTypes";

dotenv.config({ path: ".env.local" });

async function fetchAllPages<T>(
  queryBuilder: {
    range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown | null }>;
    order: (column: string, options?: { ascending?: boolean }) => typeof queryBuilder;
  },
  pageSize: number = 1000
): Promise<T[]> {
  const results: T[] = [];
  let page = 0;
  const orderedQuery = queryBuilder.order("id", { ascending: true });
  while (true) {
    const rangeStart = page * pageSize;
    const rangeEnd = (page + 1) * pageSize - 1;
    const { data, error } = await orderedQuery.range(rangeStart, rangeEnd);
    if (error) {
      throw error;
    }
    if (!data || data.length === 0) {
      break;
    }
    results.push(...data);
    if (data.length < pageSize) {
      break;
    }
    page++;
  }
  return results;
}

async function benchmarkCourseLayout(courseId: number, isStaff: boolean) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in .env.local");
  }
  const client = createClient<Database>(url, key);

  const t0 = performance.now();
  await Promise.all([
    fetchAllPages(client.from("profiles").select("*").eq("class_id", courseId)),
    isStaff
      ? fetchAllPages(
          client.from("user_roles").select("*, profiles!private_profile_id(*), users(*)").eq("class_id", courseId)
        )
      : Promise.resolve(undefined),
    isStaff
      ? fetchAllPages(client.from("discussion_threads").select("*").eq("root_class_id", courseId))
      : Promise.resolve(undefined),
    fetchAllPages(client.from("tags").select("*").eq("class_id", courseId)),
    fetchAllPages(client.from("lab_sections").select("*").eq("class_id", courseId)),
    fetchAllPages(client.from("lab_section_meetings").select("*").eq("class_id", courseId)),
    fetchAllPages(client.from("class_sections").select("*").eq("class_id", courseId)),
    isStaff
      ? fetchAllPages(client.from("student_deadline_extensions").select("*").eq("class_id", courseId))
      : Promise.resolve(undefined),
    isStaff
      ? fetchAllPages(client.from("assignment_due_date_exceptions").select("*").eq("class_id", courseId))
      : Promise.resolve(undefined),
    fetchAllPages(client.from("assignments").select("*").eq("class_id", courseId)),
    fetchAllPages(
      client
        .from("assignment_groups")
        .select("*, assignment_groups_members(*), mentor:profiles!assignment_groups_mentor_profile_id_fkey(name)")
        .eq("class_id", courseId)
    ),
    fetchAllPages(client.from("discussion_topics").select("*").eq("class_id", courseId)),
    isStaff
      ? fetchAllPages(client.from("repositories").select("*").eq("class_id", courseId))
      : Promise.resolve(undefined),
    fetchAllPages(client.from("gradebook_columns").select("*").eq("class_id", courseId)),
    isStaff
      ? fetchAllPages(client.from("discord_channels").select("*").eq("class_id", courseId))
      : Promise.resolve(undefined),
    isStaff
      ? fetchAllPages(client.from("discord_messages").select("*").eq("class_id", courseId))
      : Promise.resolve(undefined),
    isStaff
      ? fetchAllPages(client.from("surveys").select("*").eq("class_id", courseId).is("deleted_at", null))
      : Promise.resolve(undefined),
    fetchAllPages(client.from("lab_section_leaders").select("*").eq("class_id", courseId))
  ]);
  return performance.now() - t0;
}

async function benchmarkAssignmentLayout(assignmentId: number, isStaff: boolean) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in .env.local");
  }
  const client = createClient<Database>(url, key);

  const t0 = performance.now();
  await Promise.all([
    isStaff
      ? fetchAllPages(client.from("submissions").select("*").eq("assignment_id", assignmentId).eq("is_active", true))
      : Promise.resolve(undefined),
    fetchAllPages(client.from("assignment_groups").select("*").eq("assignment_id", assignmentId)),
    isStaff
      ? fetchAllPages(client.from("submission_regrade_requests").select("*").eq("assignment_id", assignmentId))
      : Promise.resolve(undefined),
    fetchAllPages(client.from("rubrics").select("*").eq("assignment_id", assignmentId)),
    fetchAllPages(client.from("rubric_parts").select("*").eq("assignment_id", assignmentId)),
    fetchAllPages(client.from("rubric_criteria").select("*").eq("assignment_id", assignmentId)),
    fetchAllPages(client.from("rubric_checks").select("*").eq("assignment_id", assignmentId)),
    fetchAllPages(client.from("rubric_check_references").select("*").eq("assignment_id", assignmentId))
  ]);
  return performance.now() - t0;
}

async function main() {
  const args = process.argv.slice(2);
  let courseId: number | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--course-id" && args[i + 1]) {
      courseId = parseInt(args[i + 1], 10);
      break;
    }
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  }
  const admin = createClient<Database>(url, key);

  if (!courseId || Number.isNaN(courseId)) {
    const { data, error } = await admin.from("classes").select("id, name").order("id", { ascending: false }).limit(1);
    if (error || !data?.[0]) {
      throw new Error(error?.message ?? "no classes");
    }
    courseId = data[0].id;
    console.log(`Using latest class id=${courseId} name=${data[0].name ?? ""}`);
  }

  console.log("\n=== Course layout SSR queries (parallel, ~same as lib/ssrUtils fetchCourseControllerData) ===\n");
  const staffMs = await benchmarkCourseLayout(courseId, true);
  console.log(`Staff/instructor parallel fetch: ${staffMs.toFixed(0)} ms`);
  const studentMs = await benchmarkCourseLayout(courseId, false);
  console.log(`Student parallel fetch: ${studentMs.toFixed(0)} ms`);

  const { data: assignments } = await admin
    .from("assignments")
    .select("id, title")
    .eq("class_id", courseId)
    .order("id", { ascending: true })
    .limit(1);

  const assignmentId = assignments?.[0]?.id;
  if (assignmentId != null) {
    console.log("\n=== Assignment layout SSR (first assignment by id) ===\n");
    console.log(`Assignment ${assignmentId}: ${assignments![0].title ?? ""}`);
    const staffA = await benchmarkAssignmentLayout(assignmentId, true);
    console.log(`Staff (includes all active submissions): ${staffA.toFixed(0)} ms`);
    const stuA = await benchmarkAssignmentLayout(assignmentId, false);
    console.log(`Student: ${stuA.toFixed(0)} ms`);
  }

  console.log("\n=== Row counts ===\n");
  const headCount = async (table: string, col: string, val: number) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count, error } = await (admin as any).from(table).select("*", { count: "exact", head: true }).eq(col, val);
    console.log(`${table} (${col}=${val}): ${error ? error.message : (count ?? "?")}`);
  };

  await headCount("profiles", "class_id", courseId);
  await headCount("user_roles", "class_id", courseId);
  await headCount("assignment_groups", "class_id", courseId);
  await headCount("assignment_groups_members", "class_id", courseId);
  await headCount("discussion_threads", "root_class_id", courseId);
  await headCount("gradebook_columns", "class_id", courseId);
  await headCount("assignments", "class_id", courseId);
  if (assignmentId != null) {
    const { count } = await admin
      .from("submissions")
      .select("*", { count: "exact", head: true })
      .eq("assignment_id", assignmentId)
      .eq("is_active", true);
    console.log(`submissions active (assignment_id=${assignmentId}): ${count ?? "?"}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
