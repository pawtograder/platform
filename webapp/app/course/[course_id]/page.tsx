import { isInstructor } from "@/lib/utils";
import { createClient } from "@/utils/supabase/server"
import { Table } from "@chakra-ui/react";
import { jwtDecode } from "jwt-decode";
import Link from "next/link";
import { useRouter } from "next/navigation"

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
  }
}