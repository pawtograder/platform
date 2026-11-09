/**
 * Rewrites an already-seeded class so its PII fields hold canaries (package 2a), for seeds that
 * don't go through `createUsersInClass`, such as `scripts/SeedDemoClass.ts --canary`. It touches only
 * rows of that class: profiles (names, sortable and short names, avatars), help requests and their
 * messages, discussion threads, rubric comments, and manual gradebook scores. Shared `users` rows
 * (the demo fleet, visiting instructors) are left alone.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import {
  canaryGrade,
  canaryPersonName,
  canarySentence,
  canaryWord,
  registerCanary,
  resolveCanary,
  type CanaryRegistry
} from "./canaryRegistry";

async function inBatches<T>(items: T[], fn: (item: T) => Promise<void>, size = 10) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

function fail(label: string, error: { message: string } | null) {
  if (error) throw new Error(`canaryizeClass: ${label}: ${error.message}`);
}

/** Replaces the class's PII with canaries and returns the registry describing them. */
export async function canaryizeClass(
  supabase: SupabaseClient<Database>,
  classId: number,
  registry: CanaryRegistry = new Map()
): Promise<CanaryRegistry> {
  const canary = resolveCanary({ registry })!;
  const lower = (s: string) => s.toLowerCase();

  // Profiles: private ones get a person's name, public ones a pseudonym tied to the real name.
  const { data: roles, error: rolesError } = await supabase
    .from("user_roles")
    .select("private_profile_id, public_profile_id")
    .eq("class_id", classId);
  fail("user_roles", rolesError);
  await inBatches(roles ?? [], async (role) => {
    const person = canaryPersonName();
    const pseudonym = canaryPersonName();
    const avatars = [canaryWord(), canaryWord()];
    const url = (seed: string) => `https://api.dicebear.com/9.x/identicon/svg?seed=${seed}`;
    const { error: e1 } = await supabase
      .from("profiles")
      .update({
        name: person.full,
        sortable_name: person.sortable,
        short_name: person.first,
        avatar_url: url(avatars[0])
      })
      .eq("id", role.private_profile_id);
    fail("private profile", e1);
    const { error: e2 } = await supabase
      .from("profiles")
      .update({ name: pseudonym.full, avatar_url: url(avatars[1]) })
      .eq("id", role.public_profile_id);
    fail("public profile", e2);
    const anchors = [lower(person.first), lower(person.last)];
    const id = role.private_profile_id;
    registerCanary(canary, person.full, { kind: "name", column: "profiles.name", rowId: id, anchors });
    registerCanary(canary, person.sortable, { kind: "name", column: "profiles.sortable_name", rowId: id, anchors });
    registerCanary(canary, person.first, {
      kind: "name",
      column: "profiles.short_name",
      rowId: id,
      anchors: [lower(person.first)]
    });
    registerCanary(canary, pseudonym.full, {
      kind: "name",
      column: "profiles.name",
      rowId: role.public_profile_id,
      realName: person.full,
      anchors: [lower(pseudonym.first), lower(pseudonym.last)]
    });
    registerCanary(canary, url(avatars[0]), {
      kind: "handle",
      column: "profiles.avatar_url",
      rowId: id,
      anchors: [avatars[0]]
    });
    registerCanary(canary, url(avatars[1]), {
      kind: "handle",
      column: "profiles.avatar_url",
      rowId: role.public_profile_id,
      anchors: [avatars[1]]
    });
  });

  // Free text, one table at a time.
  const rewrite = async (
    table: "help_requests" | "help_request_messages" | "discussion_threads" | "submission_comments",
    columns: string[]
  ) => {
    const { data, error } = await supabase.from(table).select("id").eq("class_id", classId);
    fail(table, error);
    await inBatches((data ?? []) as { id: number }[], async (row) => {
      const update: Record<string, string> = {};
      const sentences = columns.map((column) => ({ column, ...canarySentence() }));
      for (const s of sentences) update[s.column] = s.text;
      const { error: e } = await supabase
        .from(table)
        .update(update as never)
        .eq("id", row.id);
      fail(table, e);
      for (const s of sentences) {
        registerCanary(canary, s.text, {
          kind: "free_text",
          column: `${table}.${s.column}`,
          rowId: row.id,
          anchors: [s.anchor]
        });
      }
    });
  };
  await rewrite("help_requests", ["request"]);
  await rewrite("help_request_messages", ["message"]);
  await rewrite("discussion_threads", ["subject", "body"]);
  await rewrite("submission_comments", ["comment"]);

  // Grades: manual gradebook columns only; calculated columns would be recomputed over them.
  const { data: columns, error: columnsError } = await supabase
    .from("gradebook_columns")
    .select("id, max_score")
    .eq("class_id", classId)
    .is("score_expression", null);
  fail("gradebook_columns", columnsError);
  for (const column of columns ?? []) {
    const { data: cells, error } = await supabase
      .from("gradebook_column_students")
      .select("id")
      .eq("gradebook_column_id", column.id)
      .not("score", "is", null);
    fail("gradebook_column_students", error);
    await inBatches(cells ?? [], async (cell) => {
      const grade = canaryGrade(column.max_score ?? 100);
      const { error: e } = await supabase
        .from("gradebook_column_students")
        .update({ score: grade.value })
        .eq("id", cell.id);
      fail("gradebook score", e);
      registerCanary(canary, grade.text, {
        kind: "grade",
        column: "gradebook_column_students.score",
        rowId: cell.id,
        anchors: [grade.text]
      });
    });
  }
  return registry;
}
