import { createClient } from "@/utils/supabase/server";
import { jwtDecode } from "jwt-decode";
import { Database } from "@/utils/supabase/SupabaseTypes";

type UserRoleJwt = Pick<
  Database["public"]["Tables"]["user_roles"]["Row"],
  "role" | "class_id" | "public_profile_id" | "private_profile_id"
>;

type DecodedToken = {
  user_roles: UserRoleJwt[];
  // Add other expected JWT claims here if needed
};

async function getRolesForCourse(course_id: number): Promise<UserRoleJwt["role"][]> {
  const client = await createClient();
  const token = (await client.auth.getSession()).data.session?.access_token;
  // Handle the case where the token might be undefined or invalid
  if (!token) {
    return [];
  }
  try {
    const decoded = jwtDecode<DecodedToken>(token);
    // Ensure user_roles exists and is an array before filtering/mapping
    if (!decoded.user_roles || !Array.isArray(decoded.user_roles)) {
      console.error("JWT does not contain valid user_roles array");
      return [];
    }
    return decoded.user_roles.filter((role) => role.class_id === course_id).map((role) => role.role);
  } catch (error) {
    console.error("Failed to decode JWT:", error);
    return [];
  }
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
