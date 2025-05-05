'use client';
import { Button } from "@/components/ui/button";
import { toaster, Toaster } from "@/components/ui/toaster";
import { autograderCreateAssignmentRepos, EdgeFunctionError } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Icon } from "@chakra-ui/react";
import { useState } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { FaGithub } from "react-icons/fa";
export function CreateGitHubRepos({ courseId, assignmentId, releaseDate }: { courseId: number, assignmentId: number, releaseDate: string | null | undefined }) {
    const [loading, setLoading] = useState(false);
    const disabled = (releaseDate && new Date(releaseDate) > new Date()) || false;
    return (<>
        <Toaster />
        <Tooltip
        openDelay={disabled ? 0 : 1000}
        content={disabled ? "You can not create GitHub repos until the release date has passed" : "Click to ensure each student's GitHub repo is created and has correct permissions"}>
            <Button
                loading={loading}
                w="100%"
                fontSize="sm"
                justifyContent="flex-start"
                disabled={disabled}
            variant="ghost" size="xs" onClick={async () => {
                setLoading(true);
                const supabase = createClient();
                try {
                    await autograderCreateAssignmentRepos({
                        courseId,
                        assignmentId,
                    }, supabase);
                } catch (e) {
                    toaster.error({
                        title: "Error creating GitHub Repos",
                        description: `Error: ${e instanceof EdgeFunctionError ? e.details : JSON.stringify(e)}`
                    });
                } finally {
                    setLoading(false);
                }
            }}><Icon as={FaGithub} />Sync GitHub Repos</Button>
        </Tooltip>
    </>
    )
}