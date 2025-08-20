import { createClient } from "@/utils/supabase/server";
import { Database } from "@/utils/supabase/SupabaseTypes";

type UserRoleData = Pick<
  Database["public"]["Tables"]["user_roles"]["Row"],
  "role" | "class_id" | "public_profile_id" | "private_profile_id"
>;

export async function getUserRolesForCourse(course_id: number): Promise<UserRoleData | undefined> {
  const client = await createClient();
  const {
    data: { user }
  } = await client.auth.getUser();

  if (!user) {
    return undefined;
  }

  const { data: userRole } = await client
    .from("user_roles")
    .select("role, class_id, public_profile_id, private_profile_id")
    .eq("class_id", course_id)
    .eq("user_id", user.id)
    .single();

  return userRole || undefined;
}

async function getRolesForCourse(course_id: number): Promise<UserRoleData["role"][]> {
  const client = await createClient();
  const {
    data: { user }
  } = await client.auth.getUser();

  if (!user) {
    return [];
  }

  const { data: userRoles, error } = await client
    .from("user_roles")
    .select("role")
    .eq("class_id", course_id)
    .eq("user_id", user.id);

  if (error) {
    console.error("Failed to fetch user roles from database:", error);
    return [];
  }

  return userRoles?.map((role) => role.role) || [];
}
export async function getPrivateProfileId(course_id: number) {
  const client = await createClient();
  const {
    data: { user }
  } = await client.auth.getUser();

  if (!user) {
    return null;
  }

  const { data: userRole, error } = await client
    .from("user_roles")
    .select("private_profile_id")
    .eq("class_id", course_id)
    .eq("user_id", user.id)
    .single();

  if (error) {
    console.error("Failed to fetch private profile ID from database:", error);
    return null;
  }

  return userRole?.private_profile_id || null;
}
export async function getCourse(course_id: number) {
  const client = await createClient();
  const course = await client.from("classes").select("*").eq("id", course_id).single();
  return course.data;
}
export async function isInstructor(course_id: number) {
  const roles = await getRolesForCourse(course_id);
  return roles.includes("instructor");
}
export async function isGrader(course_id: number) {
  const roles = await getRolesForCourse(course_id);
  return roles.includes("grader");
}
export async function isInstructorOrGrader(course_id: number) {
  const roles = await getRolesForCourse(course_id);
  return roles.includes("instructor") || roles.includes("grader");
}
