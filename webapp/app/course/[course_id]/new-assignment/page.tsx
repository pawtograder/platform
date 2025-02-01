import { getCourse } from "@/lib/utils";
import CreateAssignment from "./form";

export default async function NewAssignmentPage({
    params,
}: {
    params: Promise<{ course_id: string }>
}) {
    const course_id = Number.parseInt((await params).course_id);
    const course = await getCourse(course_id);
    if (!course) {
        return <p>Course not found</p>
    }
    return <CreateAssignment course={course} />
}