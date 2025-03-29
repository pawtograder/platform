import { CanvasApi } from "npm:@kth/canvas-api";
import { Course, Enrollment, User, UserProfile } from "../_shared/CanvasTypes.d.ts";

const canvas = new CanvasApi(Deno.env.get("CANVAS_API_URL")!, Deno.env.get("CANVAS_API_KEY")!);

export async function getEnrollments(courseId: number): Promise<Enrollment[]> {
    const pages = await canvas.listPages(`courses/${courseId}/enrollments`);
    const ret = [];
    for await (const page of pages) {
      ret.push(...page.json);
    }
    return ret;
}
export async function getUser(userId: number): Promise<UserProfile> {
    const { json } = await canvas.get(`users/${userId}/profile`);
    return json;
}
export async function getCourse(courseId: number): Promise<Course> {
    const { json } = await canvas.get(`courses/${courseId}`);
    return json;
}
export async function listCourses(): Promise<Course[]> {
    const pages = await canvas.listPages("courses");
    const ret = [];
    for await (const page of pages) {
        ret.push(...page.json);
    }
    return ret;
}
