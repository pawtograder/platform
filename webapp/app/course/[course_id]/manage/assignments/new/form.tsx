'use client';
import { Field } from "@/components/ui/field";
import { Box, createListCollection, Fieldset, Heading, Input, ListCollection, Stack, Table, Text, VStack } from "@chakra-ui/react";
import { Controller, FieldValues, useForm } from 'react-hook-form';

import { ListFilesResponse } from "@/components/github/GitHubTypes";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import RepoSelector from "@/components/ui/repo-selector";
import { Toaster } from "@/components/ui/toaster";
import { repositoryListFiles } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

export default function CreateAssignment({ course }: { course: Database['public']['Tables']['classes']['Row'] }) {
    const router = useRouter()

    const [templateRepoFiles, setTemplateRepoFiles] = useState<ListCollection<ListFilesResponse[0]>>();
    const {
        handleSubmit,
        register,
        control,
        setValue,
        getValues,
        // refineCore: {
        //     onFinish
        // },
        formState: { errors, isSubmitting },
    } = useForm({
        // refineCoreProps: {
        //     resource: "assignments",
        //     action: "create",
        // }
    })

    const fetchTemplateRepoFiles = useCallback(async (org: string, repo: string) => {
        const supabase = createClient();
        const files = await repositoryListFiles({ courseId: course.id, orgName: org, repoName: repo }, supabase);
        setTemplateRepoFiles(createListCollection({
            items: files || [],
            itemToValue: (file) => file.path,
            itemToString: (file) => file.name
        }));
    }, [course.id]);

    const onSubmit = useCallback((values: FieldValues) => {
        async function create() {
            const supabase = createClient();
            // console.log(getValues("submission_files"));
            console.log(getValues("template_repo").full_name);
            const { data, error } = await supabase.from("assignments").insert({
                title: getValues("title"),
                slug: getValues("slug"),
                release_date: getValues("release_date"),
                due_date: getValues("due_date"),
                allow_late: getValues("allow_late"),
                late_due_date: getValues("late_due_date"),
                description: getValues("description"),
                points: getValues("points"),
                template_repo: getValues("template_repo").full_name,
                submission_files: getValues("submission_files"),
                class_id: course.id,
            }).select("id").single();
            if (error || !data) {
                console.error(error);
            } else {
                router.push(`/course/${course.id}/manage/assignments/${data.id}/autograder`)
            }
        }
        create()
    }, [handleSubmit, setValue, course.id]);

    return (<div>
        <Heading size="2xl">Create Assignment</Heading>
        <Toaster />
        <form onSubmit={handleSubmit(onSubmit)}>
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
                    <Field label="Slug"
                        helperText="A short identifier for the assignment, e.g. 'hw1' or 'project2'"
                        errorText={errors.slug?.message?.toString()}
                        invalid={errors.slug ? true : false}
                    ><Input
                            {...register('slug', {
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
                                return <RepoSelector
                                templateReposOnly
                                name={field.name} value={field.value} onBlur={field.onBlur} onChange={(val) => {
                                    fetchTemplateRepoFiles(val.owner.login, val.name);
                                    field.onChange(val)
                                }} />
                            }} />


                    </Field>
                </Fieldset.Content>
                <Fieldset.Content>
                    <Field label="Submission files"
                        helperText="Files from the template repository that students will submit"
                        errorText={errors.submission_files?.message?.toString()}
                        invalid={errors.submission_files ? true : false}
                    >
                        <Controller
                            control={control}
                            name="submission_files"
                            render={({ field }) => {
                                const selectedFiles = !field.value ? [] :
                                    (Array.isArray(field.value) ? field.value as string[] :
                                        JSON.parse(field.value as string) as string[]
                                    )
                                return (
                                    <VStack>
                                        <Text>Selected files: {selectedFiles.join(', ')}</Text>
                                        <Box height="300px" overflowY="auto">
                                            <Table.Root striped size="sm">
                                                <Table.Caption>Template repository files</Table.Caption>
                                                <Table.Header>
                                                    <Table.Row >
                                                        <Table.ColumnHeader>Select</Table.ColumnHeader>
                                                        <Table.ColumnHeader>File</Table.ColumnHeader>
                                                        <Table.ColumnHeader>Path</Table.ColumnHeader>
                                                    </Table.Row>
                                                </Table.Header>
                                                <Table.Body>
                                                    {templateRepoFiles?.items.map((file) => (
                                                        <Table.Row key={file.path}>
                                                            <Table.Cell><Checkbox checked={field.value?.includes(file.path)} name={file.path} /></Table.Cell>
                                                            <Table.Cell onClick={() => {
                                                                const value: string[] = field.value || [];
                                                                if (value.includes(file.path)) {
                                                                    field.onChange(value.filter((f) => f !== file.path));
                                                                } else {
                                                                    field.onChange([...value, file.path]);
                                                                }
                                                            }}>{file.name}</Table.Cell>
                                                            <Table.Cell onClick={() => {
                                                                const value: string[] = field.value || [];
                                                                if (value.includes(file.path)) {
                                                                    field.onChange(value.filter((f) => f !== file.path));
                                                                } else {
                                                                    field.onChange([...value, file.path]);
                                                                }
                                                            }}>{file.path}</Table.Cell>
                                                        </Table.Row>
                                                    ))}
                                                </Table.Body>
                                            </Table.Root>
                                        </Box>
                                    </VStack>
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