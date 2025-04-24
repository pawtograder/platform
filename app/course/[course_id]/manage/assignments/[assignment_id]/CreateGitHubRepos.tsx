'use client';
import { Button } from "@/components/ui/button";
import { autograderCreateAssignmentRepos } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Icon } from "@chakra-ui/react";
import { useState } from "react";
import { FaGithub } from "react-icons/fa";
export function CreateGitHubRepos({ courseId, assignmentId }: { courseId: number, assignmentId: number }) {
    const [loading, setLoading] = useState(false);
    return (
        <Button 
        loading={loading}
        w="100%"
        fontSize="sm"
        justifyContent="flex-start"
        variant="ghost" size="xs" onClick={async () => {
            setLoading(true);
            const supabase = createClient();
            await autograderCreateAssignmentRepos({
                courseId,
                assignmentId,
            }, supabase);
            setLoading(false);
        }}><Icon as={FaGithub} />Sync GitHub Repos</Button>

    )
}