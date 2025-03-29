'use client';

import { Button } from "@chakra-ui/react";
import { autograderCreateReposForStudent } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
export default function CreateStudentReposButton() {
    const supabase = createClient();
    return <Button onClick={() => autograderCreateReposForStudent(supabase)}>Create GitHub Repositories</Button>
}