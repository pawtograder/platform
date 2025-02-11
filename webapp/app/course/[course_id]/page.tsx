
import { isInstructor } from "@/lib/ssrUtils";
import InstructorPage from './instructorPage';

export default async function CourseLanding({
  params,
}: {
  params: Promise<{ course_id: string }>
}) {
  const course_id = Number.parseInt((await params).course_id);
  const instructor = await isInstructor(course_id);
  if (instructor) {
    return <InstructorPage course_id={course_id} />
  } else{
    return <div>WIP</div>
  }
}