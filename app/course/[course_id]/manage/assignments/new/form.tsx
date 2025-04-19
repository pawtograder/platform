'use client';
import { Field } from "@/components/ui/field";
import { Box, Card, CardBody, CardHeader, CardRoot, CardTitle, createListCollection, Fieldset, Heading, Input, ListCollection, NativeSelect, NativeSelectField, NativeSelectRoot, Select, Spinner, Stack, Table, Text, VStack } from "@chakra-ui/react";
import { Controller, FieldErrors, FieldValues } from 'react-hook-form';

import { ListFilesResponse } from "@/components/github/GitHubTypes";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import RepoSelector from "@/components/ui/repo-selector";
import { Toaster } from "@/components/ui/toaster";
import { repositoryListFiles } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useCourse } from "@/hooks/useAuthState";
import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { UseFormReturnType } from "@refinedev/react-hook-form";
import { useList } from "@refinedev/core";
function GroupConfigurationSubform({ form }: { form: UseFormReturnType<Assignment> }) {
    const { course_id } = useParams();
    const { data: otherAssignments } = useList({
        resource: "assignments",
        queryOptions: {
            enabled: !!course_id,
        },
        filters: [
            {
                field: "class_id",
                operator: "eq",
                value: Number.parseInt(course_id as string)
            },
            {
                field: "group_config",
                operator: "ne",
                value: "individual"
            }
        ],
        pagination: {
            pageSize: 1000,
        }
    })

    const {
        register,
        control,
        setValue,
        getValues,
        formState: { errors },
    } = form;
    return (<CardRoot>
        <CardHeader>
            <CardTitle>Group Configuration</CardTitle>
        </CardHeader>
        <CardBody>
            <Fieldset.Content>
                <Field label="Group configuration" helperText="If you want to use groups for this assignment, select the group configuration you want to use."
                    errorText={errors.group_config?.message?.toString()}
                    invalid={errors.group_config ? true : false}
                    required={true}
                >
                    <NativeSelectRoot {...register("group_config", { required: true })}>
                        <NativeSelectField name="group_config">
                            <option value="individual">Individual Submissions Only</option>
                            <option value="groups">Group Submissions Only</option>
                            <option value="both">Individual or Group Submissions</option>
                        </NativeSelectField>
                    </NativeSelectRoot>
                </Field>
            </Fieldset.Content>
            <Fieldset.Content>
                <Field label="Minimum Group Size"
                    helperText="The minimum number of students allowed in a group"
                    errorText={errors.min_group_size?.message?.toString()}
                    invalid={errors.min_group_size ? true : false}
                >
                    <Input
                        type="number"
                        {...register('min_group_size', {
                            required: getValues("group_config") === "groups" || getValues("group_config") === "both" ? "This is required for group assignments" : false,
                            min: { value: 1, message: 'Minimum group size must be at least 1' }
                        })}
                    />
                </Field>
            </Fieldset.Content>
            <Fieldset.Content>
                <Field label="Maximum Group Size"
                    helperText="The maximum number of students allowed in a group"
                    errorText={errors.max_group_size?.message?.toString()}
                    invalid={errors.max_group_size ? true : false}
                >
                    <Input
                        type="number"
                        {...register('max_group_size', {
                            required: getValues("group_config") === "groups" || getValues("group_config") === "both" ? "This is required for group assignments" : false,
                            min: { value: 1, message: 'Maximum group size must be at least 1' }
                        })}
                    />
                </Field>
            </Fieldset.Content>
            <Fieldset.Content>
                <Field label="Group Formation Method"
                    helperText="Choose whether students can form their own groups or if groups will be assigned by instructors"
                    errorText={errors.allow_student_formed_groups?.message?.toString()}
                    invalid={errors.allow_student_formed_groups ? true : false}
                >
                    <NativeSelectRoot {...register("allow_student_formed_groups", { required: getValues("group_config") === "groups" || getValues("group_config") === "both" ? "This is required for group assignments" : false })}>
                        <NativeSelectField name="allow_student_formed_groups">
                            <option value="true">Students Form Groups</option>
                            <option value="false">Instructor Forms Groups</option>
                        </NativeSelectField>
                    </NativeSelectRoot>
                </Field>
            </Fieldset.Content>
            <Fieldset.Content>
                <Field label="Copy groups from assignment"
                    helperText="Copy groups from another assignment"
                >
                    <NativeSelectRoot {...register("copy_groups_from_assignment", { required: false })}>
                        <NativeSelectField name="copy_groups_from_assignment">
                            <option value="">None</option>
                            {otherAssignments?.data?.map((assignment) => <option key={assignment.id} value={assignment.id}>{assignment.title}</option>)}
                        </NativeSelectField>
                    </NativeSelectRoot>
                </Field>
            </Fieldset.Content>
            <Fieldset.Content>
                <Field label="Group Formation Deadline"
                    helperText="The deadline by which groups must be formed. If set, students will not be able to change groups after this deadline."
                    errorText={errors.group_formation_deadline?.message?.toString()}
                    invalid={errors.group_formation_deadline ? true : false}
                >
                    <Input
                        type="datetime-local"
                        {...register('group_formation_deadline', {
                            required: getValues("group_config") === "groups" || getValues("group_config") === "both" ? "This is required for group assignments" : false
                        })}
                    />
                </Field>
            </Fieldset.Content>
        </CardBody>
    </CardRoot>)
}

export default function AssignmentForm({ form, onSubmit }: { form: UseFormReturnType<Assignment>, onSubmit: (values: FieldValues) => void }) {
    const router = useRouter()
    const { course_id } = useParams();

    const [templateRepoFiles, setTemplateRepoFiles] = useState<ListCollection<ListFilesResponse[0]>>();
    const {
        handleSubmit,
        register,
        control,
        setValue,
        getValues,
        refineCore,
        // refineCore: {
        //     onFinish
        // },
        formState: { errors, isSubmitting },
    } = form;

    const course = useCourse();

    const [isLoadingTemplateRepoFiles, setIsLoadingTemplateRepoFiles] = useState(false);
    const fetchTemplateRepoFiles = useCallback(async (org: string, repo: string) => {
        const supabase = createClient();
        setIsLoadingTemplateRepoFiles(true);
        const files = await repositoryListFiles({ courseId: Number.parseInt(course_id as string), orgName: org, repoName: repo }, supabase);
        setTemplateRepoFiles(createListCollection({
            items: files || [],
            itemToValue: (file) => file.path,
            itemToString: (file) => file.name
        }));
        setIsLoadingTemplateRepoFiles(false);
    }, [course_id]);

    useEffect(() => {
        const templateRepo = getValues("template_repo");
        if (templateRepo) {
            const [login, repo] = templateRepo.split("/");
            fetchTemplateRepoFiles(login, repo);
        }
    }, [getValues, fetchTemplateRepoFiles]);
    useEffect(() => {
        const templateRepo = refineCore.query?.data?.data.template_repo;
        if (templateRepo) {
            const [login, repo] = templateRepo.split("/");
            fetchTemplateRepoFiles(login, repo);
        }
    }, [refineCore.query?.data?.data.template_repo, fetchTemplateRepoFiles]);

    return (<div>
        <Toaster />
        <form onSubmit={handleSubmit(onSubmit)}>
            <Fieldset.Root maxW="lg">
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
                        helperText="A short identifier for the assignment, e.g. 'hw1' or 'project2'. Must contain only lowercase letters, numbers, underscores, and hyphens, and be less than 16 characters."
                        errorText={errors.slug?.message?.toString()}
                        invalid={errors.slug ? true : false}
                    ><Input
                            {...register('slug', {
                                required: 'This is required',
                                pattern: {
                                    value: /^[a-z0-9_-]+$/,
                                    message: 'Slug must contain only lowercase letters, numbers, underscores, and hyphens'
                                },
                                maxLength: {
                                    value: 16,
                                    message: 'Slug must be less than 16 characters'
                                }
                            })} /></Field>
                </Fieldset.Content>
                <Fieldset.Content>
                    <Field label={`Release Date (${course.classes.time_zone})`} helperText="Date that students can see the assignment"
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
                    <Field label={`Due Date (${course.classes.time_zone})`}
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
                    <Field label={`Late Due Date (${course.classes.time_zone})`} helperText="Assignments submitted after the due date but before the late due date are accepted as 'Late', and not accepted later unless a student has an extension."><Input name="late_due_date" type="datetime-local" /></Field>
                </Fieldset.Content>
                <Fieldset.Content>
                    <Field label="Description URL" helperText="A link to the description of the assignment, e.g. on a course website or in Canvas"><Input name="description" /></Field>
                </Fieldset.Content>
                <Fieldset.Content>
                    <Field label="Points Possible"><Input name="points" type="number" /></Field>
                </Fieldset.Content>
                <GroupConfigurationSubform form={form} />
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
                                    name={field.name} value={field.value ? field.value : ""} onBlur={field.onBlur} onChange={(val) => {
                                        const [login, repo] = val.split("/");
                                        fetchTemplateRepoFiles(login, repo);
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
                        <Text fontSize="sm" color="fg.muted">Click on the name of file or path to toggle select</Text>
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
                                        <Text fontSize="sm" color="fg.muted">Selected files: {selectedFiles.join(', ')}</Text>
                                        <Box height="300px" overflowY="auto">
                                            {isLoadingTemplateRepoFiles ? <Spinner /> :
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
                                                        {templateRepoFiles?.items.map((file) => {
                                                            return (
                                                                <Table.Row key={file.path}>
                                                                    <Table.Cell><Checkbox
                                                                        checked={field.value ? (field.value as string[]).includes(file.path) : false} name={file.path} /></Table.Cell>
                                                                    <Table.Cell onClick={() => {
                                                                        const value: string[] = field.value as string[] || [];
                                                                        if (value.includes(file.path)) {
                                                                            field.onChange(value.filter((f) => f !== file.path));
                                                                        } else {
                                                                            field.onChange([...value, file.path]);
                                                                        }
                                                                    }}>{file.name}</Table.Cell>
                                                                    <Table.Cell onClick={() => {
                                                                        const value: string[] = field.value as string[] || [];
                                                                        if (value.includes(file.path)) {
                                                                            field.onChange(value.filter((f) => f !== file.path));
                                                                        } else {
                                                                            field.onChange([...value, file.path]);
                                                                        }
                                                                    }}>{file.path}</Table.Cell>
                                                                </Table.Row>
                                                            )
                                                        })}
                                                    </Table.Body>
                                                </Table.Root>
                                            }
                                        </Box>
                                    </VStack>
                                )
                            }} />
                    </Field>
                </Fieldset.Content>
                <Fieldset.Content>
                    <Button type="submit" loading={isSubmitting}>Save</Button>
                </Fieldset.Content>

            </Fieldset.Root>
        </form>
    </div>
    );
}