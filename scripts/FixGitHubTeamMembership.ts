import { createAdminClient } from "@/utils/supabase/client";
import { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function printUsage() {
  console.log("Usage:");
  console.log("  npx tsx scripts/FixGitHubTeamMembership.ts <user_email>");
  console.log("");
  console.log("Arguments:");
  console.log("  user_email  - The email address of the user whose GitHub team membership should be fixed");
  console.log("");
  console.log("Example:");
  console.log("  npx tsx scripts/FixGitHubTeamMembership.ts student@northeastern.edu");
  console.log("");
  console.log("This script will enqueue GitHub team sync requests for all classes the user is enrolled in.");
}

const email = process.argv[2];

if (!email) {
  console.error("Error: No email specified");
  printUsage();
  process.exit(1);
}

async function fixGitHubTeamMembership(userEmail: string) {
  const supabase = createAdminClient<Database>();

  console.log(`Looking up user with email: ${userEmail}`);

  // Find the user by email
  const { data: user, error: userError } = await supabase
    .from("users")
    .select("user_id, email, github_username")
    .eq("email", userEmail)
    .single();

  if (userError || !user) {
    console.error(`User not found with email: ${userEmail}`);
    if (userError) console.error("Error:", userError.message);
    process.exit(1);
  }

  console.log(`Found user: ${user.user_id}`);
  console.log(`  Email: ${user.email}`);
  console.log(`  GitHub username: ${user.github_username || "(not linked)"}`);

  if (!user.github_username) {
    console.error("\n❌ User does not have a linked GitHub account. Cannot fix team membership.");
    process.exit(1);
  }

  // Get all class enrollments for this user
  const { data: roles, error: rolesError } = await supabase
    .from("user_roles")
    .select("role, class_id, classes(id, slug, github_org)")
    .eq("user_id", user.user_id)
    .eq("disabled", false);

  if (rolesError) {
    console.error("Error fetching user roles:", rolesError.message);
    process.exit(1);
  }

  if (!roles || roles.length === 0) {
    console.log("\nUser is not enrolled in any classes.");
    process.exit(0);
  }

  console.log(`\nUser is enrolled in ${roles.length} class(es):`);

  let enqueuedCount = 0;
  let skippedCount = 0;

  for (const role of roles) {
    const classInfo = role.classes;
    if (!classInfo || !classInfo.github_org || !classInfo.slug) {
      console.log(`  - Class ${role.class_id}: Skipping (missing GitHub org or slug)`);
      skippedCount++;
      continue;
    }

    console.log(`\n  Class: ${classInfo.slug} (ID: ${classInfo.id})`);
    console.log(`    Role: ${role.role}`);
    console.log(`    GitHub Org: ${classInfo.github_org}`);

    // Determine which team sync to enqueue based on role
    if (role.role === "student") {
      console.log(`    Enqueueing student team sync...`);
      const { data: messageId, error: enqueueError } = await supabase.rpc("enqueue_github_sync_student_team", {
        p_class_id: classInfo.id,
        p_org: classInfo.github_org,
        p_course_slug: classInfo.slug,
        p_affected_user_id: user.user_id,
        p_debug_id: `fix-membership-${user.user_id}-${Date.now()}`
      });

      if (enqueueError) {
        console.error(`    ❌ Error enqueueing student team sync:`, enqueueError.message);
      } else {
        console.log(`    ✅ Enqueued student team sync (message ID: ${messageId})`);
        enqueuedCount++;
      }
    } else if (role.role === "instructor" || role.role === "grader") {
      console.log(`    Enqueueing staff team sync...`);
      const { data: messageId, error: enqueueError } = await supabase.rpc("enqueue_github_sync_staff_team", {
        p_class_id: classInfo.id,
        p_org: classInfo.github_org,
        p_course_slug: classInfo.slug,
        p_affected_user_id: user.user_id,
        p_debug_id: `fix-membership-${user.user_id}-${Date.now()}`
      });

      if (enqueueError) {
        console.error(`    ❌ Error enqueueing staff team sync:`, enqueueError.message);
      } else {
        console.log(`    ✅ Enqueued staff team sync (message ID: ${messageId})`);
        enqueuedCount++;
      }
    } else {
      console.log(`    Skipping unknown role: ${role.role}`);
      skippedCount++;
    }
  }

  console.log(`\n========================================`);
  console.log(`Summary for ${userEmail}:`);
  console.log(`  ✅ Enqueued: ${enqueuedCount} team sync request(s)`);
  if (skippedCount > 0) {
    console.log(`  ⚠️  Skipped: ${skippedCount} class(es)`);
  }
  console.log(`========================================`);

  if (enqueuedCount > 0) {
    console.log(`\nThe GitHub async worker will process these requests shortly.`);
  }
}

fixGitHubTeamMembership(email).catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});

