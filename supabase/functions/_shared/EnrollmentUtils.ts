import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";

let nameGenerationNouns: string[] = [];
let nameGenerationAdjectives: string[] = [];
async function generateRandomName(supabase: SupabaseClient<Database>) {
  if (nameGenerationNouns.length === 0) {
    const { data: words, error: wordsError } = await supabase.from("name_generation_words").select("*");
    if (wordsError) {
      console.error(wordsError);
      throw new Error("Error getting words from name_generation_words");
    }
    if (!words) {
      throw new Error("No words found in name_generation_words");
    }
    nameGenerationAdjectives = words.filter((word) => word.is_adjective).map((word) => word.word);
    nameGenerationNouns = words.filter((word) => word.is_noun).map((word) => word.word);
  }
  const adjective = nameGenerationAdjectives[Math.floor(Math.random() * nameGenerationAdjectives.length)];
  const noun = nameGenerationNouns[Math.floor(Math.random() * nameGenerationNouns.length)];
  const number = Math.floor(Math.random() * 1000);
  return `${adjective}-${noun}-${number}`;
}
export async function createUserInClass(
  supabase: SupabaseClient<Database>,
  courseId: number,
  user: {
    existing_user_id?: string;
    primary_email: string;
    canvas_id?: number;
    canvas_course_id?: number;
    canvas_section_id?: number;
    class_section_id?: number;
    time_zone?: string;
    name: string;
    sortable_name?: string;
    short_name?: string;
    avatar_url?: string;
  },
  newRole: Database["public"]["Enums"]["app_role"]
) {
  let userId = user.existing_user_id;

  if (!user.primary_email) {
    console.error(`No email found for user ${user.name}`);
    console.error(JSON.stringify(user, null, 2));
    throw new Error("No email found for user " + user.name);
  }

  if (!userId) {
    console.log("Creating user", user.primary_email);
    if (user.primary_email.endsWith("@northeastern.edu")) {
      const newUser = await supabase.auth.admin.createUser({
        email: user.primary_email,
        email_confirm: true
      });
      if (newUser.error) {
        console.error(newUser.error);
        throw new Error("Error creating user");
      }
      console.log("Created user", newUser);
      userId = newUser.data.user!.id;
    } else {
      const newUser = await supabase.auth.admin.inviteUserByEmail(user.primary_email);
      if (newUser.error) {
        console.error(newUser.error);
        throw new Error("Error creating user");
      }
      console.log("Invited user", newUser);
      userId = newUser.data.user!.id;
    }
  }

  // --- Determine avatar_url for private profile based on input ---
  let privateProfileAvatarUrl = user.avatar_url;
  if (
    !privateProfileAvatarUrl ||
    privateProfileAvatarUrl === "https://northeastern.instructure.com/images/messages/avatar-50.png"
  ) {
    privateProfileAvatarUrl = `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(user.name)}`;
  }

  // --- Fetch ALL existing roles and their associated profile IDs for this user in this class ---
  const { data: existingUserRoles, error: fetchRolesError } = await supabase
    .from("user_roles")
    .select("id, role, canvas_id, private_profile_id, public_profile_id")
    .eq("user_id", userId!)
    .eq("class_id", courseId);

  if (fetchRolesError) {
    console.error("Error fetching existing roles:", fetchRolesError);
    throw new Error("Could not fetch existing user roles.");
  }

  let highestExistingRoleEntry: (typeof existingUserRoles)[0] | undefined = undefined;
  let foundPrivateProfileId: string | null = null;
  let foundPublicProfileId: string | null = null;
  const roleHierarchy: ReadonlyArray<Database["public"]["Enums"]["app_role"]> = ["instructor", "grader", "student"];

  if (existingUserRoles && existingUserRoles.length > 0) {
    existingUserRoles.forEach((r) => {
      if (
        !highestExistingRoleEntry ||
        roleHierarchy.indexOf(r.role) < roleHierarchy.indexOf(highestExistingRoleEntry.role)
      ) {
        highestExistingRoleEntry = r;
      }
      if (r.private_profile_id) foundPrivateProfileId = r.private_profile_id;
      if (r.public_profile_id) foundPublicProfileId = r.public_profile_id;
    });
  }

  // --- Manage Private Profile (Create or Update) ---
  let privateProfileIdToUse: string;
  if (foundPrivateProfileId) {
    console.log(`Updating existing private profile ${foundPrivateProfileId} for user ${user.name}`);
    const { error: updateProfileError } = await supabase
      .from("profiles")
      .update({
        name: user.name,
        sortable_name: user.sortable_name,
        short_name: user.short_name,
        avatar_url: privateProfileAvatarUrl
        // class_id and is_private_profile should not change here
      })
      .eq("id", foundPrivateProfileId);

    if (updateProfileError) {
      console.error(
        `Error updating private profile ${foundPrivateProfileId} for user ${user.name}:`,
        updateProfileError
      );
    }
    privateProfileIdToUse = foundPrivateProfileId;
  } else {
    console.log(`Creating new private profile for user ${user.name} in class ${courseId}`);
    const { data: newPrivateProfileData, error: createProfileError } = await supabase
      .from("profiles")
      .insert({
        name: user.name,
        sortable_name: user.sortable_name,
        short_name: user.short_name,
        avatar_url: privateProfileAvatarUrl,
        class_id: courseId,
        is_private_profile: true
      })
      .select("id")
      .single();

    if (createProfileError || !newPrivateProfileData) {
      console.error(`Error creating private profile for user ${user.name}:`, createProfileError);
      throw new Error("Error creating private profile.");
    }
    privateProfileIdToUse = newPrivateProfileData.id;
  }

  // --- Manage Public Profile (Create if not exists) ---
  let publicProfileIdToUse: string;
  if (foundPublicProfileId) {
    publicProfileIdToUse = foundPublicProfileId;
  } else {
    console.log(`Creating new public profile for user (associated with ${user.name}) in class ${courseId}`);
    const newPublicProfileName = await generateRandomName(supabase);
    const { data: newPublicProfileData, error: publicProfileError } = await supabase
      .from("profiles")
      .insert({
        name: newPublicProfileName,
        avatar_url: `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(newPublicProfileName)}`,
        class_id: courseId,
        is_private_profile: false
      })
      .select("id")
      .single();

    if (publicProfileError || !newPublicProfileData) {
      console.error("Error creating public profile:", publicProfileError);
      throw new Error("Error creating public profile.");
    }
    publicProfileIdToUse = newPublicProfileData.id;
  }

  // --- Role Logic ---
  const newRolePriority = roleHierarchy.indexOf(newRole);

  if (highestExistingRoleEntry) {
    const highestExistingRolePriority = roleHierarchy.indexOf(highestExistingRoleEntry.role);

    if (newRolePriority < highestExistingRolePriority) {
      console.log(
        `New role ${newRole} is higher priority than existing ${highestExistingRoleEntry.role}. Replacing all existing roles for this user in this class.`
      );
      const idsToDelete = existingUserRoles!.map((r) => r.id);
      await supabase.from("user_roles").delete().in("id", idsToDelete);

      // Insert the new, higher-priority role
      console.log(`Inserting new (upgraded) role ${newRole} for user ${userId} in class ${courseId}.`);
      const { error: insertError } = await supabase.from("user_roles").insert({
        user_id: userId!,
        class_id: courseId,
        role: newRole,
        canvas_id: user.canvas_id,
        class_section_id: user.class_section_id,
        public_profile_id: publicProfileIdToUse,
        private_profile_id: privateProfileIdToUse
      });
      if (insertError) {
        console.error("Error inserting upgraded user role:", insertError);
        throw new Error("Error inserting upgraded user role: " + insertError.message);
      }
    } else if (newRolePriority === highestExistingRolePriority) {
      console.log(`User already has role ${newRole}. Updating canvas_id and class_section_id if changed.`);
      const updates: Partial<Database["public"]["Tables"]["user_roles"]["Row"]> = {};
      if (user.canvas_id !== undefined && user.canvas_id !== highestExistingRoleEntry.canvas_id) {
        updates.canvas_id = user.canvas_id;
      }
      if (user.class_section_id !== undefined) {
        // Assuming class_section_id can also be updated
        updates.class_section_id = user.class_section_id;
      }

      // Also ensure the profile IDs are correctly linked if they somehow got detached or were never set on this specific role entry
      if (publicProfileIdToUse && publicProfileIdToUse !== highestExistingRoleEntry.public_profile_id) {
        updates.public_profile_id = publicProfileIdToUse;
      }
      if (privateProfileIdToUse && privateProfileIdToUse !== highestExistingRoleEntry.private_profile_id) {
        updates.private_profile_id = privateProfileIdToUse;
      }

      if (Object.keys(updates).length > 0) {
        const { error: updateError } = await supabase
          .from("user_roles")
          .update(updates)
          .eq("id", highestExistingRoleEntry.id);
        if (updateError) {
          console.error("Error updating user role (same priority):", updateError);
          throw updateError;
        }
      }
      // Role exists and is updated if necessary.
    } else {
      console.log(
        `User already has a higher or equal role (${highestExistingRoleEntry.role}). New role ${newRole} not added.`
      );
      // Do nothing to roles if new role is lower priority
    }
  } else {
    // No existing role for this user in this class
    console.log(`No existing role found. Inserting new role ${newRole} for user ${userId} in class ${courseId}.`);
    const { error: insertError } = await supabase.from("user_roles").insert({
      user_id: userId!,
      class_id: courseId,
      role: newRole,
      canvas_id: user.canvas_id,
      class_section_id: user.class_section_id,
      public_profile_id: publicProfileIdToUse,
      private_profile_id: privateProfileIdToUse
    });

    if (insertError) {
      console.error("Error inserting new user role:", insertError);
      throw new Error("Error inserting new user role: " + insertError.message);
    }
  }
  console.log(`Successfully processed enrollment for user ${userId} with role ${newRole}.`);
}
