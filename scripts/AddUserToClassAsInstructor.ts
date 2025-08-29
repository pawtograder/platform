import { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
dotenv.config({ path: ".env.local" });

function printUsage() {
  console.log("Usage:");
  console.log("  npx tsx scripts/AddUserToClassAsInstructor.ts <course_id> <user_email>");
  console.log("  npx tsx scripts/AddUserToClassAsInstructor.ts <course_id> --csv <csv_file>");
  console.log("");
  console.log("Arguments:");
  console.log("  course_id   - The numeric ID of the course");
  console.log("  user_email  - The email address of the user to add as instructor");
  console.log("  --csv       - Use CSV mode to add multiple users");
  console.log("  csv_file    - Path to CSV file with 'name' and 'email' columns");
  console.log("");
  console.log("Examples:");
  console.log("  npx tsx scripts/AddUserToClassAsInstructor.ts 123 instructor@northeastern.edu");
  console.log("  npx tsx scripts/AddUserToClassAsInstructor.ts 123 --csv instructors.csv");
  console.log("");
  console.log("CSV Format:");
  console.log("  name,email[,role]");
  console.log("  John Doe,john.doe@northeastern.edu,instructor");
  console.log("  Jane Smith,jane.smith@northeastern.edu,student");
  console.log("  Bob Wilson,bob.wilson@northeastern.edu,grader");
  console.log("");
  console.log("Notes:");
  console.log("  - The 'role' column is optional. If not provided, defaults to 'instructor'");
  console.log("  - Valid roles: student, instructor, grader");
}

// Parse command line arguments
const courseID = parseInt(process.argv[2]);
const isCSVMode = process.argv[3] === "--csv";
const userEmail = isCSVMode ? undefined : process.argv[3];
const csvFile = isCSVMode ? process.argv[4] : undefined;

// Validate arguments
if (!courseID || isNaN(courseID)) {
  console.error("Invalid course ID provided");
  printUsage();
  process.exit(1);
}

if (isCSVMode) {
  if (process.argv.length !== 5 || !csvFile) {
    console.error("CSV file path required when using --csv option");
    printUsage();
    process.exit(1);
  }
  if (!fs.existsSync(csvFile)) {
    console.error(`CSV file not found: ${csvFile}`);
    process.exit(1);
  }
} else {
  if (process.argv.length !== 4 || !userEmail) {
    console.error("User email required when not using CSV mode");
    printUsage();
    process.exit(1);
  }
}

const supabase = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

interface CsvUser {
  name: string;
  email: string;
  role?: string;
}

function parseCSV(csvContent: string): CsvUser[] {
  const lines = csvContent.trim().split("\n");
  if (lines.length < 2) {
    throw new Error("CSV file must have at least a header row and one data row");
  }

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const nameIndex = headers.indexOf("name");
  const emailIndex = headers.indexOf("email");
  const roleIndex = headers.indexOf("role");

  if (nameIndex === -1) {
    throw new Error("CSV file must have a 'name' column");
  }
  if (emailIndex === -1) {
    throw new Error("CSV file must have an 'email' column");
  }

  const users: CsvUser[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map((v) => v.trim());
    const requiredColumns = Math.max(nameIndex + 1, emailIndex + 1);

    if (values.length >= requiredColumns) {
      const name = values[nameIndex].replace(/^"(.*)"$/, "$1"); // Remove quotes if present
      const email = values[emailIndex].replace(/^"(.*)"$/, "$1"); // Remove quotes if present
      const role = roleIndex !== -1 && values[roleIndex] ? values[roleIndex].replace(/^"(.*)"$/, "$1") : undefined;

      if (name && email) {
        const user: CsvUser = { name, email };
        if (role) {
          user.role = role;
        }
        users.push(user);
      }
    }
  }

  return users;
}

async function generatePseudonym(): Promise<string> {
  const { data: words, error: wordsError } = await supabase.from("name_generation_words").select("*");
  if (wordsError) {
    console.error("Error getting words from name_generation_words:", wordsError);
    throw new Error("Error getting words for pseudonym generation");
  }
  if (!words || words.length === 0) {
    throw new Error("No words found in name_generation_words table");
  }

  const adjectives = words.filter((word) => word.is_adjective).map((word) => word.word);
  const nouns = words.filter((word) => word.is_noun).map((word) => word.word);

  if (adjectives.length === 0 || nouns.length === 0) {
    throw new Error("No adjectives or nouns found in name_generation_words table");
  }

  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const number = Math.floor(Math.random() * 10000);

  return `${adjective}-${noun}-${number}`;
}

async function checkGravatarExists(email: string): Promise<string | null> {
  try {
    const hash = crypto.createHash("md5").update(email.toLowerCase().trim()).digest("hex");
    const gravatarUrl = `https://www.gravatar.com/avatar/${hash}?d=404&s=200`;

    const response = await fetch(gravatarUrl, { method: "HEAD" });
    if (response.ok) {
      // Return the gravatar URL without the d=404 parameter for actual usage
      return `https://www.gravatar.com/avatar/${hash}?s=200`;
    }
    return null;
  } catch (error) {
    console.warn("Error checking Gravatar:", error);
    return null;
  }
}

function validateRole(role?: string): Database["public"]["Enums"]["app_role"] {
  const validRoles: Database["public"]["Enums"]["app_role"][] = ["student", "instructor", "grader"];

  if (!role) {
    return "instructor"; // Default role
  }

  const normalizedRole = role.toLowerCase() as Database["public"]["Enums"]["app_role"];
  if (validRoles.includes(normalizedRole)) {
    return normalizedRole;
  }

  throw new Error(`Invalid role: ${role}. Valid roles are: ${validRoles.join(", ")}`);
}

async function addUserToClass(
  email: string,
  name?: string,
  role?: string
): Promise<{ success: boolean; skipped: boolean }> {
  const validatedRole = validateRole(role);
  console.log(`Adding user ${email} as ${validatedRole} to course ${courseID}`);

  // First, check if user exists in users table
  let { data: user } = await supabase.from("users").select("*").eq("email", email).single();
  let userId: string;

  if (!user) {
    console.log(`User not found in users table, creating new user: ${email}`);

    // Create user in Supabase Auth
    const createUserResult =
      email.endsWith("@northeastern.edu") && !email.includes("+")
        ? await supabase.auth.admin.createUser({
            email: email,
            email_confirm: true
          })
        : await supabase.auth.admin.inviteUserByEmail(email);

    if (createUserResult.error) {
      console.error("Error creating user in auth:", createUserResult.error);
      return { success: false, skipped: false };
    }

    userId = createUserResult.data.user!.id;
    console.log(`Created auth user with ID: ${userId}`);

    // Insert into users table
    const { data: newUser, error: insertUserError } = await supabase
      .from("users")
      .insert({
        user_id: userId,
        email: email,
        name: name || email
      })
      .select("*")
      .single();

    if (insertUserError) {
      console.error("Error creating user in users table:", insertUserError);
      return { success: false, skipped: false };
    }

    user = newUser;
    console.log(`Created user record: ${user.name || user.email}`);
  } else {
    userId = user.user_id;
    console.log(`Found existing user: ${user.name || user.email}`);
  }

  // Check if user already has this role in this class
  const { data: existingRoles } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("class_id", courseID)
    .eq("role", validatedRole);

  if (existingRoles && existingRoles.length > 0) {
    console.log(`⚠️  User ${email} already has role '${validatedRole}' in course ${courseID}. Skipping.`);
    return { success: true, skipped: true };
  }

  // Look for existing private profiles for this user
  const { data: userRoles } = await supabase.from("user_roles").select("private_profile_id").eq("user_id", userId);

  let existingPrivateProfiles = null;
  if (userRoles && userRoles.length > 0) {
    const privateProfileIds = userRoles.map((role) => role.private_profile_id).filter((id) => id !== null);

    if (privateProfileIds.length > 0) {
      const { data } = await supabase
        .from("profiles")
        .select("name, avatar_url")
        .eq("is_private_profile", true)
        .in("id", privateProfileIds)
        .limit(1);
      existingPrivateProfiles = data;
    }
  }

  // Determine private profile name and avatar - use provided name if available
  let privateProfileName = name || user.name || user.email;
  let privateProfileAvatarUrl: string;

  // Check Gravatar first
  console.log("Checking for Gravatar...");
  const gravatarUrl = await checkGravatarExists(email);

  if (gravatarUrl) {
    console.log("Found Gravatar, using it for private profile avatar");
    privateProfileAvatarUrl = gravatarUrl;
  } else if (existingPrivateProfiles && existingPrivateProfiles.length > 0) {
    console.log("Using name and avatar from existing private profile");
    const existingProfile = existingPrivateProfiles[0];
    privateProfileName = existingProfile.name || privateProfileName;
    privateProfileAvatarUrl =
      existingProfile.avatar_url ||
      `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(privateProfileName || email)}`;
  } else {
    console.log("No existing profile found, generating new identicon for private profile");
    privateProfileAvatarUrl = `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(privateProfileName || email)}`;
  }

  // Create private profile
  console.log("Creating private profile...");
  const { data: privateProfile, error: privateProfileError } = await supabase
    .from("profiles")
    .insert({
      name: privateProfileName,
      class_id: courseID,
      is_private_profile: true,
      avatar_url: privateProfileAvatarUrl
    })
    .select("id")
    .single();

  if (privateProfileError) {
    console.error("Error creating private profile:", privateProfileError);
    return { success: false, skipped: false };
  }

  // Generate pseudonym for public profile
  console.log("Generating pseudonym for public profile...");
  const pseudonym = await generatePseudonym();
  console.log(`Generated pseudonym: ${pseudonym}`);

  // Create public profile with generated pseudonym
  console.log("Creating public profile...");
  const { data: publicProfile, error: publicProfileError } = await supabase
    .from("profiles")
    .insert({
      name: pseudonym,
      class_id: courseID,
      avatar_url: `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(pseudonym)}`,
      is_private_profile: false
    })
    .select("id")
    .single();

  if (publicProfileError) {
    console.error("Error creating public profile:", publicProfileError);
    return { success: false, skipped: false };
  }

  // Enroll user in class
  console.log(`Enrolling user as ${validatedRole}...`);
  const { error: enrollmentError } = await supabase.from("user_roles").insert({
    user_id: userId,
    class_id: courseID,
    role: validatedRole,
    private_profile_id: privateProfile.id,
    public_profile_id: publicProfile.id
  });

  if (enrollmentError) {
    console.error("Error enrolling user:", enrollmentError);
    return { success: false, skipped: false };
  }

  console.log(`✅ Successfully added user as ${validatedRole}!`);
  console.log(`Private profile: ${privateProfileName}`);
  console.log(`Public profile: ${pseudonym}`);
  console.log(`Private avatar: ${privateProfileAvatarUrl}`);
  console.log(""); // Empty line for readability
  return { success: true, skipped: false };
}

async function main() {
  try {
    if (isCSVMode && csvFile) {
      console.log(`Processing CSV file: ${csvFile}`);
      const csvContent = fs.readFileSync(csvFile, "utf-8");
      const users = parseCSV(csvContent);

      console.log(`Found ${users.length} users in CSV file`);
      console.log("========================================");

      let successCount = 0;
      let skippedCount = 0;
      let failureCount = 0;

      for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const roleInfo = user.role ? ` as ${user.role}` : " as instructor (default)";
        console.log(`Processing user ${i + 1}/${users.length}: ${user.name} (${user.email})${roleInfo}`);

        try {
          const result = await addUserToClass(user.email, user.name, user.role);
          if (result.success) {
            if (result.skipped) {
              skippedCount++;
            } else {
              successCount++;
            }
          } else {
            failureCount++;
          }
        } catch (error) {
          console.error(`Error processing user ${user.email}:`, error);
          failureCount++;
        }
      }

      console.log("========================================");
      console.log(`✅ Successfully processed: ${successCount} users`);
      if (skippedCount > 0) {
        console.log(`⚠️  Skipped (already enrolled): ${skippedCount} users`);
      }
      if (failureCount > 0) {
        console.log(`❌ Failed to process: ${failureCount} users`);
      }
      console.log(`📊 Total: ${users.length} users`);
    } else if (userEmail) {
      // Single user mode
      const result = await addUserToClass(userEmail);
      if (!result.success) {
        process.exit(1);
      }
    } else {
      console.error("Invalid arguments");
      printUsage();
      process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
