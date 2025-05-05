import { createClient } from "@/utils/supabase/server";
import { jwtDecode } from "jwt-decode";

async function getRolesForCourse(course_id: number) {
  const client = await createClient();
  const token = (await client.auth.getSession()).data.session?.access_token;
  const decoded = jwtDecode(token || "") as any;
  return decoded.user_roles.filter((role: any) => role.class_id === course_id).map((role: any) => role.role);
}
export async function getCourse(course_id: number) {
  const client = await createClient();
  const course = await client.from("classes").select("*").eq("id", course_id).single();
  return course.data;
}
export async function isInstructor(course_id: number) {
  const roles = await getRolesForCourse(course_id);
  return (await getRolesForCourse(course_id)).includes("instructor");
}
