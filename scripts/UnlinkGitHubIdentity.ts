import { createAdminClient } from "@/utils/supabase/client";
import { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function printUsage() {
  console.log("Usage:");
  console.log("  npx tsx scripts/UnlinkGitHubIdentity.ts <user_email>");
  console.log("");
  console.log("Arguments:");
  console.log("  user_email  - The email address of the user whose GitHub identity should be unlinked");
  console.log("");
  console.log("Example:");
  console.log("  npx tsx scripts/UnlinkGitHubIdentity.ts student@northeastern.edu");
}

const email = process.argv[2];

if (!email) {
  console.error("Error: No email specified");
  printUsage();
  process.exit(1);
}

async function unlinkGitHubIdentity(userEmail: string) {
  const adminSupabase = createAdminClient<Database>();

  console.log(`Unlinking GitHub identity for: ${userEmail}`);

  // Generate magic link to sign in as the user
  console.log("Generating magic link...");
  const { data: magicLinkData, error: magicLinkError } = await adminSupabase.auth.admin.generateLink({
    email: userEmail,
    type: "magiclink"
  });

  if (magicLinkError || !magicLinkData.properties?.hashed_token) {
    console.error("Error generating magic link:", magicLinkError?.message);
    process.exit(1);
  }

  // Create a user client with the anon key
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables");
    process.exit(1);
  }

  const userSupabase = createClient<Database>(supabaseUrl, supabaseAnonKey);

  // Verify the OTP to get a session as the user
  console.log("Signing in as user...");
  const { data: sessionData, error: sessionError } = await userSupabase.auth.verifyOtp({
    token_hash: magicLinkData.properties.hashed_token,
    type: "magiclink"
  });

  if (sessionError || !sessionData.session) {
    console.error("Error verifying magic link:", sessionError?.message);
    process.exit(1);
  }

  const userId = sessionData.user?.id;
  console.log(`Signed in as user: ${userId}`);

  // Get the user's identities
  const { data: identitiesData, error: identitiesError } = await userSupabase.auth.getUserIdentities();

  if (identitiesError) {
    console.error("Error getting user identities:", identitiesError.message);
    process.exit(1);
  }

  if (!identitiesData?.identities || identitiesData.identities.length === 0) {
    console.log("User has no linked identities");
    process.exit(0);
  }

  console.log(`User has ${identitiesData.identities.length} identity/identities:`);
  identitiesData.identities.forEach((identity) => {
    console.log(`  - Provider: ${identity.provider}, ID: ${identity.id}`);
  });

  const githubIdentity = identitiesData.identities.find((identity) => identity.provider === "github");

  if (!githubIdentity) {
    console.log("No GitHub identity found for this user");
    process.exit(0);
  }

  console.log(`\nFound GitHub identity:`);
  console.log(`  Identity ID: ${githubIdentity.id}`);
  console.log(`  Provider ID: ${githubIdentity.identity_id}`);

  // Unlink the GitHub identity as the user
  console.log("\nUnlinking GitHub identity...");
  const { error: unlinkError } = await userSupabase.auth.unlinkIdentity(githubIdentity);

  if (unlinkError) {
    console.error("Error unlinking GitHub identity:", unlinkError.message);
    console.log("\nIf automatic unlinking failed, run this SQL manually in Supabase SQL editor:");
    console.log(`DELETE FROM auth.identities WHERE user_id = '${userId}' AND provider = 'github';`);
    process.exit(1);
  }

  console.log(`\n✅ Successfully unlinked GitHub identity for ${userEmail}`);
}

unlinkGitHubIdentity(email).catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});

