import { createListCollection, Fieldset, Heading, Input, ListCollection, SelectLabel, SelectValueText, Skeleton, Stack, Table, TableCaption, TableBody, Box, VStack, Text, HStack } from "@chakra-ui/react";
import { Controller, Field, FieldValues, useForm } from 'react-hook-form';

import { ListFilesResponse, ListReposResponse } from "@/components/github/GitHubTypes";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectContent, SelectItem, SelectRoot, SelectTrigger } from "@/components/ui/select";
import { Toaster, toaster } from "@/components/ui/toaster";
import { fetchGetRepos, fetchGetTemplateRepos, fetchListFilesInRepo } from "@/lib/generated/pawtograderComponents";
import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { SupabaseClient } from "@supabase/supabase-js";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Assignment } from "@/utils/supabase/DatabaseTypes";

export default function RepoSelector({ name, value, onBlur, onChange, templateReposOnly }: { name: string, value: string[], onBlur: () => void, onChange: (value: ListReposResponse[0]) => void, templateReposOnly?: boolean }) {
    const { course_id } = useParams();
    const [templateReposList, setTemplateReposList] = useState<ListCollection<ListReposResponse[0]>>();
    useEffect(() => {
        async function fetchRepos() {
            const repos = await (templateReposOnly ? fetchGetTemplateRepos({ pathParams: { courseId: Number(course_id) } }) :
                 fetchGetRepos({ pathParams: { courseId: Number(course_id) } }));
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