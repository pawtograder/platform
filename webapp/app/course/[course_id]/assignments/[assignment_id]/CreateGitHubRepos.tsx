'use client';
import { Button } from "@/components/ui/button";
import { fetchCreateAssignmentRepositories } from "@/lib/generated/pawtograderComponents";

export function CreateGitHubRepos({ courseId, assignmentId }: { courseId: number, assignmentId: number }) {
    return (
        <Button onClick={() => {
            fetchCreateAssignmentRepositories({
                pathParams:
                    { courseId, assignmentId }
            });
        }}>Create Repos</Button>

    )
}