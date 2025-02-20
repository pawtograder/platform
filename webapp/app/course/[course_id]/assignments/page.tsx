import { isInstructor } from "@/lib/ssrUtils";
import { createClient } from "@/utils/supabase/server";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Table } from "@chakra-ui/react";
import { UnstableGetResult as GetResult } from '@supabase/postgrest-js';
import InstructorPage from "./instructorPage";
import StudentPage from "./studentPage";
export default async function AssignmentsPage({ params }: { params: Promise<{ course_id: string }> }) {
    const { course_id } = await params;
    const instructor = await isInstructor(Number.parseInt(course_id));
    if (instructor) {
        return await InstructorPage({ course_id: Number.parseInt(course_id) });
    }
    return await StudentPage({ course_id: Number.parseInt(course_id) });
}