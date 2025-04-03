'use client';
import { Button } from "@/components/ui/button";
import { autograderCreateAssignmentRepos } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
export function CreateGitHubRepos({ courseId, assignmentId }: { courseId: number, assignmentId: number }) {
    return (
        <Button variant="surface" size="xs" onClick={() => {
            const supabase = createClient();
            autograderCreateAssignmentRepos({
                courseId,
                assignmentId,
            }, supabase);
        }}>Manually sync assignment repos</Button>

    )
}