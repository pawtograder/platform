import dotenv from "dotenv";
import Canvas, { CanvasApi } from "@kth/canvas-api";
import { createClient } from "@supabase/supabase-js";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Enrollment } from "@/lib/CanvasTypes";
import { createObjectCsvWriter } from 'csv-writer';
dotenv.config({ path: "./supabase/functions/.env" });
dotenv.config({ path: "./.env.local.prod" });

/**
 * This script connects to Canvas and finds users that are not in Pawtograder, exporting a CSV of the users that are missing.
 */
const COURSE_ID = 8;
function getCanvas(id: number) {
    const canvas_api_url = process.env[`CANVAS_API_URL_${id}`] || process.env.CANVAS_API_URL;
    const canvas_api_key = process.env[`CANVAS_API_KEY_${id}`] || process.env.CANVAS_API_KEY;
    return new CanvasApi(canvas_api_url!, canvas_api_key!);
}

export async function getEnrollments({ class_id, canvas_course_id, canvas_course_section_id }: { class_id: number, canvas_course_id: number | null, canvas_course_section_id: number | null }):Promise<Enrollment[]> {
    const canvas = getCanvas(class_id);
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
async function main() {
    const adminSupabase = createClient<Database>(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const { data: courses } = await adminSupabase.from("classes").select("*, class_sections(*)").eq("id", COURSE_ID).single();
    const canvasEnrollments = (await Promise.all(courses!.class_sections.map(
        (section) => {
            return getEnrollments(section);
        }))).flat();
    const supabaseEnrollments = await adminSupabase.from("user_roles").select("*, profiles!private_profile_id(name, sortable_name, avatar_url)").eq(
        "class_id",
        COURSE_ID,
    );
    const missingEnrollments = canvasEnrollments.filter(canvasEnrollment => 
        canvasEnrollment.user.name !== ("Test Student") &&
        !supabaseEnrollments.data!.find(supabaseEnrollment => supabaseEnrollment.canvas_id === canvasEnrollment.user.id))
    const writer = createObjectCsvWriter({
        path: "missing_enrollments.csv",
        header: [
            { id: "name", title: "Name" },
            { id: "email", title: "Email" },
            { id: "role", title: "Role" },
            { id: "canvas_id", title: "Canvas ID" },
            { id: "canvas_section_id", title: "Canvas Section ID" },
            { id: "canvas_course_id", title: "Canvas Course ID" },
        ],
    });
    const dbRoleForCanvasRole = (
        role: string,
      ): Database["public"]["Enums"]["app_role"] => {
        switch (role) {
          case "StudentEnrollment":
            return "student";
          case "TeacherEnrollment":
            return "instructor";
          case "TaEnrollment":
            return "grader";
          case "ObserverEnrollment":
            return "student";
          default:
            return "student";
        }
    };
    await writer.writeRecords(missingEnrollments.map(e => ({
        name: e.user.name,
        email: '',
        role: dbRoleForCanvasRole(e.role),
        canvas_id: e.user.id,
        canvas_section_id: e.course_section_id,
        canvas_course_id: e.course_id,
    })));
}
main();
