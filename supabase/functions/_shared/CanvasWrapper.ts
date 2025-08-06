import { CanvasApi } from "npm:@kth/canvas-api";
import { Course, Enrollment, UserProfile } from "../_shared/CanvasTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";

function getCanvas(id: number) {
  const canvas_api_url = Deno.env.get(`CANVAS_API_URL_${id}`) || Deno.env.get("CANVAS_API_URL");
  const canvas_api_key = Deno.env.get(`CANVAS_API_KEY_${id}`) || Deno.env.get("CANVAS_API_KEY");
  return new CanvasApi(canvas_api_url!, canvas_api_key!);
}
export async function getEnrollments(
  {
    class_id,
    canvas_course_id,
    canvas_course_section_id
  }: {
    class_id: number;
    canvas_course_id: number | null;
    canvas_course_section_id: number | null;
  },
  scope?: Sentry.Scope
): Promise<Enrollment[]> {
  scope?.setTag("canvas_operation", "get_enrollments");
  scope?.setTag("class_id", class_id.toString());
  if (canvas_course_id) scope?.setTag("canvas_course_id", canvas_course_id.toString());
  if (canvas_course_section_id) scope?.setTag("canvas_course_section_id", canvas_course_section_id.toString());

  const canvas = getCanvas(class_id);
  if (canvas_course_id) {
    console.log("Getting enrollments for course", canvas_course_id);
    const pages = await canvas.listPages(`courses/${canvas_course_id}/enrollments`);
    const ret = [];
    for await (const page of pages) {
      ret.push(...page.json);
    }
    return ret;
  } else if (canvas_course_section_id) {
    console.log("Getting enrollments for section", canvas_course_section_id);
    const pages = await canvas.listPages(`sections/${canvas_course_section_id}/enrollments`);
    const ret = [];
    for await (const page of pages) {
      ret.push(...page.json);
    }
    return ret;
  }
  throw new Error("Either canvas_course_id or canvas_section_id must be provided");
}
export async function getUser(classId: number, userId: number, scope?: Sentry.Scope): Promise<UserProfile> {
  scope?.setTag("canvas_operation", "get_user");
  scope?.setTag("class_id", classId.toString());
  scope?.setTag("canvas_user_id", userId.toString());

  const canvas = getCanvas(classId);
  const { json } = await canvas.get(`users/${userId}/profile`);
  return json;
}
export async function getCourse(courseId: number, scope?: Sentry.Scope): Promise<Course> {
  scope?.setTag("canvas_operation", "get_course");
  scope?.setTag("canvas_course_id", courseId.toString());

  const canvas = getCanvas(courseId);
  const { json } = await canvas.get(`courses/${courseId}`);
  return json;
}
