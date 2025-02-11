'use client';
import { Field } from "@/components/ui/field";
import { createListCollection, Fieldset, Heading, Input, ListCollection, SelectLabel, SelectValueText, Skeleton, Stack } from "@chakra-ui/react";
import { Controller, useForm } from 'react-hook-form';

import { ListReposResponse } from "@/components/github/GitHubTypes";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectContent, SelectItem, SelectRoot, SelectTrigger } from "@/components/ui/select";
import { Toaster, toaster } from "@/components/ui/toaster";
import { fetchGetTemplateRepos } from "@/lib/generated/pawtograderComponents";
import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { SupabaseClient } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

export default function CreateAssignment({ course }: { course: Database['public']['Tables']['classes']['Row'] }) {
    const [templateReposList, setTemplateReposList] = useState<ListCollection<ListReposResponse[0]>>();
    const router = useRouter()

    const {
        handleSubmit,
        register,
        control,
        formState: { errors, isSubmitting },
    } = useForm()
    useEffect(() => {

        fetchGetTemplateRepos({ pathParams: { courseId: course.id } }).then(
            (templateRepos) => {
                const reposCollection = createListCollection({
                    items: templateRepos || [],
                    itemToValue: (repo) => '' + repo.id,
                    itemToString: (repo) => repo.owner.login + "/" + repo.name
                });
                setTemplateReposList(reposCollection);
            }
        )
    }, []);

    const create = useCallback(async (values: any) => {
        async function onSubmit(values: any) {
            //Create assignment here


            const supabase: SupabaseClient<Database> = await createClient();
            const resp = await supabase.from('assignments').insert({
                title: values.title,
                release_date: values.release_date,
                due_date: values.due_date,
                allow_late: values.allow_late,
                late_due_date: values.late_due_date,
                description: values.description,
                points: values.points,
                template_repo: values.template_repo,
                class_id: course.id
            }).select('*').single();
            if (resp.error) {
                console.error(resp.error)
                throw new Error(resp.error.message)
            }
            if (resp.data) {
                console.log(resp.data)
                const assignment = resp.data;
                router.push(`/course/${course.id}/assignments/${assignment.id}`)
            }
        }
        return toaster.promise(() => onSubmit(values), {
            success: {
                description: "Assignment created successfully",
                title: "Success"
            },
            loading: {
                description: "Creating assignment...",
                title: "Creating assignment"
            },
            error: {
                description: "Failed to create assignment",
                title: "Error"
            }
        })

    }, []);



    return (<div>
        <Heading size="2xl">Create Assignment</Heading>
        <Toaster />
        <form onSubmit={handleSubmit(create)}>
            <Fieldset.Root size="lg" maxW="md">
                <Stack>
                    <Fieldset.Legend>New Assignment details</Fieldset.Legend>
                    <Fieldset.HelperText>Note that all dates/times are local to the course timezone ({course.time_zone}), set in Canvas</Fieldset.HelperText>
                </Stack>
                <Fieldset.Content>
                    <Field label="Title"
                        errorText={errors.title?.message?.toString()}
                        invalid={errors.title ? true : false}
                    ><Input
                            {...register('title', {
                                required: 'This is required',
                            })} /></Field>
                </Fieldset.Content>
                <Fieldset.Content>
                    <Field label="Release Date" helperText="Date that students can see the assignment"
                        errorText={errors.release_date?.message?.toString()}
                        invalid={errors.release_date ? true : false}
                    ><Input
                            type="datetime-local"
                            {...register('release_date', {
                                required: 'This is required',
                            })}
                        /></Field>
                </Fieldset.Content>
                <Fieldset.Content>
                    <Field label="Due Date"
                        helperText="No submissions accepted after this time unless late submissions are allowed"
                        errorText={errors.due_date?.message?.toString()}
                        invalid={errors.due_date ? true : false}
                    ><Input type="datetime-local"
                        {...register('due_date', {
                            required: 'This is required',
                        })}
                        /></Field>
                </Fieldset.Content>
                <Fieldset.Content>
                    <Field label="Allow Late Submissions"><Checkbox name="allow_late" /></Field>
                </Fieldset.Content>
                <Fieldset.Content>
                    <Field label="Late Due Date" helperText="Assignments submitted after the due date but before the late due date are accepted as 'Late', and not accepted later unless a student has an extension."><Input name="late_due_date" type="datetime-local" /></Field>
                </Fieldset.Content>
                <Fieldset.Content>
                    <Field label="Description URL" helperText="A link to the description of the assignment, e.g. on a course website or in Canvas"><Input name="description" /></Field>
                </Fieldset.Content>
                <Fieldset.Content>
                    <Field label="Points Possible"><Input name="points" type="number" /></Field>
                </Fieldset.Content>
                <Fieldset.Content>
                    <Field label="Template repository" helperText="A link to a repository that will be used as a template for each student's assignment"
                        errorText={errors.template_repo?.message?.toString()}
                        invalid={errors.template_repo ? true : false}
                    >
                        <Controller
                            control={control}
                            name="template_repo"
                            render={({ field }) => {
                                if (!templateReposList) return <Skeleton height="20px" />;
                                return (
                                    <SelectRoot collection={templateReposList}
                                        name={field.name}
                                        value={field.value}
                                        multiple={false}
                                        onValueChange={(details) => {
                                            console.log(details)
                                            field.onChange(details.items[0])
                                        }}
                                        onInteractOutside={() => field.onBlur()}
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
                            }} />


                    </Field>
                </Fieldset.Content>
                <Fieldset.Content>
                    <Button type="submit">Create Assignment</Button>
                </Fieldset.Content>

            </Fieldset.Root>
        </form>
    </div>
    );
}