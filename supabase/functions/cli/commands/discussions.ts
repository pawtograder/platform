/**
 * discussions.* CLI commands — discussions.list (cli:read).
 */

import type { MCPAuthContext } from "../../_shared/MCPAuth.ts";
import { registerCommand } from "../router.ts";
import { getAdminClient } from "../utils/supabase.ts";
import { classSummary, resolveClass } from "../utils/resolvers.ts";
import { assertUserCanAccessClass } from "../utils/auth.ts";
import { pageAll } from "../utils/paging.ts";
import { CLICommandError } from "../errors.ts";
import type { CLIResponse } from "../types.ts";

/**
 * Assignment ids per `.in()` batch. Numeric ids cost ~8 bytes in the query string, so
 * this keeps the filter well inside the URL limit while staying under `max_rows` for
 * the response — one id resolves to at most one row here.
 */
const ASSIGNMENT_ID_BATCH_SIZE = 500;

const THREAD_PAGE = 1000;

interface DiscussionsListParams {
  class?: string | number;
}

interface TopicCounts {
  threads: number;
  questions: number;
  unanswered: number;
}

/**
 * Tallies root threads per topic.
 *
 * There is no aggregate column or view for this — the discussion feed
 * (`app/course/[course_id]/discussion/page.tsx`) and the topic-management page
 * both count in memory over the class's threads, so we do the same, but paged
 * by id cursor rather than an unbounded `select("*")`.
 *
 * Root threads are the ones with no `parent`. Drafts are excluded because they
 * are not visible to anyone but their author, and duplicate-merged threads are
 * excluded because the UI hides them from topic counts.
 */
async function fetchTopicCounts(
  supabase: ReturnType<typeof getAdminClient>,
  classId: number
): Promise<Map<number, TopicCounts>> {
  const counts = new Map<number, TopicCounts>();
  let cursor = 0;

  for (;;) {
    const { data, error } = await supabase
      .from("discussion_threads")
      .select("id, topic_id, is_question, answer")
      .eq("class_id", classId)
      .is("parent", null)
      .is("duplicate_marked_at", null)
      .eq("draft", false)
      .gt("id", cursor)
      .order("id", { ascending: true })
      .limit(THREAD_PAGE);

    if (error) {
      throw new CLICommandError(`Failed to count discussion threads: ${error.message}`, 500);
    }

    const rows = data ?? [];
    for (const row of rows) {
      const entry = counts.get(row.topic_id) ?? { threads: 0, questions: 0, unanswered: 0 };
      entry.threads += 1;
      if (row.is_question) {
        entry.questions += 1;
        if (row.answer == null) entry.unanswered += 1;
      }
      counts.set(row.topic_id, entry);
    }

    if (rows.length < THREAD_PAGE) break;
    cursor = rows[rows.length - 1]!.id;
  }

  return counts;
}

async function handleDiscussionsList(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as unknown as DiscussionsListParams;
  if (!p.class) throw new CLICommandError("class is required");

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, p.class);
  await assertUserCanAccessClass(supabase, ctx.userId, classData.id);

  // Paged for the same reason fetchTopicCounts is: an unpaged select is silently
  // capped at max_rows, which would drop later topics while still reporting a
  // complete summary.
  const topics = await pageAll<{
    id: number;
    topic: string;
    description: string;
    color: string;
    ordinal: number;
    assignment_id: number | null;
    show_in_office_hours: boolean;
    created_at: string;
  }>(
    () =>
      supabase
        .from("discussion_topics")
        .select("id, topic, description, color, ordinal, assignment_id, show_in_office_hours, created_at")
        .eq("class_id", classData.id)
        .order("ordinal", { ascending: true })
        .order("id", { ascending: true }),
    "Failed to list discussion topics"
  );

  const counts = await fetchTopicCounts(supabase, classData.id);

  // Resolve linked assignment slugs in batches rather than per topic. One `.in()` over
  // every collected id was capped two ways: the response silently truncates at
  // `max_rows`, leaving later topics with a null slug, and a long enough id list
  // overruns the URL limit and fails the whole command.
  const assignmentIds = [...new Set(topics.map((t) => t.assignment_id).filter((id): id is number => id != null))];
  const assignmentSlugs = new Map<number, string>();
  for (let i = 0; i < assignmentIds.length; i += ASSIGNMENT_ID_BATCH_SIZE) {
    const batch = assignmentIds.slice(i, i + ASSIGNMENT_ID_BATCH_SIZE);
    const assignments = await pageAll<{ id: number; slug: string | null }>(
      () => supabase.from("assignments").select("id, slug").in("id", batch).order("id", { ascending: true }),
      "Failed to resolve linked assignments"
    );
    for (const a of assignments) {
      if (a.slug) assignmentSlugs.set(a.id, a.slug);
    }
  }

  const rows = topics.map((t) => {
    const c = counts.get(t.id) ?? { threads: 0, questions: 0, unanswered: 0 };
    return {
      id: t.id,
      topic: t.topic,
      description: t.description,
      color: t.color,
      ordinal: t.ordinal,
      assignment_id: t.assignment_id,
      assignment_slug: t.assignment_id != null ? (assignmentSlugs.get(t.assignment_id) ?? null) : null,
      show_in_office_hours: t.show_in_office_hours,
      created_at: t.created_at,
      threads: c.threads,
      questions: c.questions,
      unanswered_questions: c.unanswered
    };
  });

  return {
    success: true,
    data: {
      class: classSummary(classData),
      topics: rows,
      summary: {
        topics: rows.length,
        threads: rows.reduce((sum, r) => sum + r.threads, 0),
        questions: rows.reduce((sum, r) => sum + r.questions, 0),
        unanswered_questions: rows.reduce((sum, r) => sum + r.unanswered_questions, 0)
      }
    }
  };
}

registerCommand({
  name: "discussions.list",
  requiredScope: "cli:read",
  handler: handleDiscussionsList
});
