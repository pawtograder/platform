'use client';

import { useParams } from "next/navigation";
import { useForm } from "@refinedev/react-hook-form";
import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { createListCollection, Fieldset, ListCollection } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import { ListReposResponse } from "@/components/github/GitHubTypes";
import { repositoriesForClass } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
export default function EditAssignment() {
    const { course_id, assignment_id } = useParams();
    const { refineCore: { query, formLoading },
        saveButtonProps, register, control, formState: { errors } } = useForm<Assignment>({
            refineCoreProps: {
                resource: "assignments",
                id: Number.parseInt(assignment_id as string)
            }
        });
    const [templateReposList, setTemplateReposList] = useState<ListCollection<ListReposResponse[0]>>();
    useEffect(() => {
        const supabase = createClient();
        repositoriesForClass({ courseId: Number.parseInt(course_id as string), template_only: true }, supabase).then(
            (templateRepos) => {
                const reposCollection = createListCollection({
                    items: templateRepos || [],
                    itemToValue: (repo) => '' + repo.id,
                    itemToString: (repo) => repo.owner.login + "/" + repo.name
                });
                setTemplateReposList(reposCollection);
            }
        )
    }, [course_id]);
    if (!query || formLoading) {
        return <div>Loading...</div>
    }
    if (query.error) {
        return <div>Error: {query.error.message}</div>
    }
    return <div>
        <form>
            <Fieldset.Root size="lg" maxW="md">
            </Fieldset.Root>
        </form>
    </div>
}