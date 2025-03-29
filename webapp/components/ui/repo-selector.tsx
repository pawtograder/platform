import { createListCollection, ListCollection, SelectLabel, SelectValueText, Skeleton } from "@chakra-ui/react";

import { ListReposResponse } from "@/components/github/GitHubTypes";
import { SelectContent, SelectItem, SelectRoot, SelectTrigger } from "@/components/ui/select";
import { repositoriesForClass } from "@/lib/edgeFunctions";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/utils/supabase/client";
export default function RepoSelector({ name, value, onBlur, onChange, templateReposOnly }: { name: string, value: string[], onBlur: () => void, onChange: (value: ListReposResponse[0]) => void, templateReposOnly?: boolean }) {
    const { course_id } = useParams();
    const [templateReposList, setTemplateReposList] = useState<ListCollection<ListReposResponse[0]>>();
    useEffect(() => {
        async function fetchRepos() {
            const supabase = createClient();
            const repos = await repositoriesForClass({ courseId: Number(course_id), template_only: templateReposOnly }, supabase);
            const reposCollection = createListCollection({
                items: repos || [],
                itemToValue: (repo) => repo.owner.login + "/" + repo.name,
                itemToString: (repo) => repo.owner.login + "/" + repo.name
            });

            reposCollection.items.sort((a, b) => a.owner.login.localeCompare(b.owner.login) || a.name.localeCompare(b.name));
            setTemplateReposList(reposCollection);
        }
        fetchRepos();
    }, []);
    if (!templateReposList) return <Skeleton height="20px" />;
    return (
        <SelectRoot collection={templateReposList}
            name={name}
            value={value}
            multiple={false}
            onValueChange={(details) => {
                onChange(details.items[0])
            }}
            onInteractOutside={() => onBlur()}
        >
            <SelectLabel>Repository</SelectLabel>
            <SelectTrigger>
                <SelectValueText placeholder="..." />
            </SelectTrigger>
            <SelectContent>
                {templateReposList.items.map((repo) => (
                    <SelectItem key={repo.id} item={repo}>{repo.owner.login}/{repo.name}</SelectItem>
                ))}</SelectContent>
        </SelectRoot>
    )
}