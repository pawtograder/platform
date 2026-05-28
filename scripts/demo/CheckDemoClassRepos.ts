/* eslint-disable no-console */
/**
 * CheckDemoClassRepos — dump the live repo/group/confirmation state for a demo
 * class so we can see WHY a group repo shows "Not Ready, blocked".
 *
 * The repositories management page shows "student has not joined course org"
 * for ANY repo where is_github_ready=false AND the user_roles embed is null —
 * and group repos always have profile_id=null → null user_roles → that message,
 * regardless of actual org status. So that message is not reliable for groups.
 * This script prints the ground truth:
 *   • user_roles.github_org_confirmed for every enrolled member
 *   • assignment_groups + members per assignment
 *   • repositories rows (individual vs group) with is_github_ready
 *
 * Usage:
 *   npx tsx scripts/demo/CheckDemoClassRepos.ts            # latest is_demo class
 *   npx tsx scripts/demo/CheckDemoClassRepos.ts --class-id 584
 */
import dotenv from "dotenv";

import { createAdminClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";

dotenv.config({ path: ".env.local", quiet: true });

const supabase = createAdminClient<Database>();

async function resolveClassId(): Promise<number> {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf("--class-id");
  if (idx >= 0 && argv[idx + 1]) {
    const n = parseInt(argv[idx + 1], 10);
    if (Number.isNaN(n)) throw new Error("--class-id must be a number");
    return n;
  }
  const { data, error } = await supabase
    .from("classes")
    .select("id, name, slug")
    .eq("is_demo", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (error || !data) throw new Error(`Could not find a demo class: ${error?.message ?? "none"}`);
  console.log(`(no --class-id given; using latest demo class ${data.id} "${data.name}" slug=${data.slug})`);
  return data.id;
}

async function main() {
  const classId = await resolveClassId();
  console.log(`\n=== Demo class ${classId} ===`);

  // 1. Enrollment + github_org_confirmed
  const { data: roles, error: rErr } = await supabase
    .from("user_roles")
    .select("user_id, role, private_profile_id, github_org_confirmed, users(github_username, email)")
    .eq("class_id", classId)
    .eq("role", "student");
  if (rErr) throw new Error(`load user_roles: ${rErr.message}`);
  console.log(`\n👤 Student enrollments (${roles?.length ?? 0}):`);
  for (const r of roles ?? []) {
    const u = Array.isArray(r.users) ? r.users[0] : r.users;
    console.log(
      `   ${u?.email ?? "?"} (gh=${u?.github_username ?? "—"}) confirmed=${r.github_org_confirmed} profile=${r.private_profile_id?.slice(0, 8)}`
    );
  }

  // 2. Assignments + group config
  const { data: assignments, error: aErr } = await supabase
    .from("assignments")
    .select("id, slug, group_config, release_date, due_date, template_repo")
    .eq("class_id", classId)
    .order("id", { ascending: true });
  if (aErr) throw new Error(`load assignments: ${aErr.message}`);
  console.log(`\n📚 Assignments (${assignments?.length ?? 0}):`);
  for (const a of assignments ?? []) {
    console.log(
      `   [${a.id}] ${a.slug} group_config=${a.group_config} release=${a.release_date} template_repo=${a.template_repo ?? "—"}`
    );
  }

  // 3. Groups + members
  const { data: groups, error: gErr } = await supabase
    .from("assignment_groups")
    .select("id, name, assignment_id, assignment_groups_members(profile_id)")
    .eq("class_id", classId);
  if (gErr) throw new Error(`load assignment_groups: ${gErr.message}`);
  console.log(`\n👥 Assignment groups (${groups?.length ?? 0}):`);
  for (const g of groups ?? []) {
    const members = Array.isArray(g.assignment_groups_members) ? g.assignment_groups_members : [];
    console.log(
      `   group[${g.id}] "${g.name}" assignment=${g.assignment_id} members=${members.map((m) => m.profile_id?.slice(0, 8)).join(",")}`
    );
  }

  // 4. Repositories: individual vs group, readiness
  const { data: repos, error: repoErr } = await supabase
    .from("repositories")
    .select("id, repository, assignment_id, profile_id, assignment_group_id, is_github_ready, synced_repo_sha")
    .eq("class_id", classId)
    .order("assignment_id", { ascending: true });
  if (repoErr) throw new Error(`load repositories: ${repoErr.message}`);
  console.log(`\n📦 Repositories (${repos?.length ?? 0}):`);
  for (const r of repos ?? []) {
    const kind = r.assignment_group_id != null ? `group#${r.assignment_group_id}` : `indiv:${r.profile_id?.slice(0, 8)}`;
    console.log(
      `   a=${r.assignment_id} ${kind} ready=${r.is_github_ready} synced_sha=${r.synced_repo_sha ? "yes" : "no"} ${r.repository}`
    );
  }

  // 5. Summary of group assignments missing a ready repo
  console.log(`\n🔎 Group-assignment readiness:`);
  for (const a of assignments ?? []) {
    if (a.group_config !== "groups" && a.group_config !== "both") continue;
    const groupsForA = (groups ?? []).filter((g) => g.assignment_id === a.id);
    for (const g of groupsForA) {
      const repo = (repos ?? []).find((r) => r.assignment_group_id === g.id);
      if (!repo) {
        console.log(`   ✗ ${a.slug} group "${g.name}" — NO repositories row (platform never created it)`);
      } else if (!repo.is_github_ready) {
        console.log(`   ⚠ ${a.slug} group "${g.name}" — repo row exists but is_github_ready=false (${repo.repository})`);
      } else {
        console.log(`   ✓ ${a.slug} group "${g.name}" — ready (${repo.repository})`);
      }
    }
  }
}

main().catch((e) => {
  console.error("❌ Check failed:", e);
  process.exit(1);
});
