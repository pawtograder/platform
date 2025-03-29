'use client';
import { Button } from "@/components/ui/button";
import { autograderCreateAssignmentRepos } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
export function CreateGitHubRepos({ courseId, assignmentId }: { courseId: number, assignmentId: number }) {
    return (
        <Button onClick={() => {
            const supabase = createClient();
            autograderCreateAssignmentRepos({
                courseId,
                assignmentId,
            }, supabase);
        }}>Manually create repos</Button>

    )
}