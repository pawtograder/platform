import { CanvasApi } from "npm:@kth/canvas-api";
import { Course, Enrollment, UserProfile } from "../_shared/CanvasTypes.d.ts";

const canvas = new CanvasApi(Deno.env.get("CANVAS_API_URL")!, Deno.env.get("CANVAS_API_KEY")!);

export async function getEnrollments({ canvas_course_id, canvas_course_section_id }: { canvas_course_id: number | null, canvas_course_section_id: number | null }): Promise<Enrollment[]> {
    if (canvas_course_id) {
        console.log("Getting enrollments for course", canvas_course_id);
        const pages = await canvas.listPages(`courses/${canvas_course_id}/enrollments`);
        const ret = [];
        for await (const page of pages) {
            ret.push(...page.json);
        }
        return ret;
    }
    else if (canvas_course_section_id) {
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
