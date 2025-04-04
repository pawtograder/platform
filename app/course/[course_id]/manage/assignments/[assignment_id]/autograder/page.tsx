"use client";

import { Field } from "@/components/ui/field";
import { Radio } from "@/components/ui/radio";
import RepoSelector from "@/components/ui/repo-selector";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Button, Fieldset, Input, RadioGroup } from "@chakra-ui/react";
import { Edit } from "@refinedev/chakra-ui";
import { useForm } from "@refinedev/react-hook-form";
import { useParams } from "next/navigation";
import { Controller, FieldValues } from "react-hook-form";
import { ListReposResponse } from "@/components/github/GitHubTypes";
import { useState, useCallback } from "react";
import AutograderConfiguration from "@/components/ui/autograder-configuration";
import { Autograder, Assignment } from "@/utils/supabase/DatabaseTypes";
import { createClient } from "@/utils/supabase/client";
import { useUpdate } from "@refinedev/core";
import { githubRepoConfigureWebhook } from "@/lib/edgeFunctions";

export default function AutograderPage() {
    const { assignment_id } = useParams();
    const [graderRepo, setGraderRepo] = useState<string>();
    const { mutateAsync: mutateAssignment } = useUpdate<Assignment>({ resource: "assignments", id: Number.parseInt(assignment_id as string) });
    const { refineCore: { formLoading, query },
        saveButtonProps,
        register,
        handleSubmit,
        refineCore,
        control,
        formState: { errors },
    } = useForm<Autograder>({
        refineCoreProps: {
            action: "edit",
            resource: "autograder",
            id: Number.parseInt(assignment_id as string),
            meta: {
                select: "*, assignments(*)"
            }
        }
    });
    const onSubmit = useCallback(async (values: FieldValues) => {
        const supabase = createClient();
        await githubRepoConfigureWebhook(
            {
                assignment_id: Number.parseInt(assignment_id as string),
                new_repo: values.grader_repo,
                watch_type: "grader_solution"
            },
            supabase
        )
        mutateAssignment({
            values: {
                has_autograder: values.assignments.has_autograder.value === "true"
            }
        });
        // refineCore.onFinish({ grader_repo: values.grader_repo });
    }, [refineCore, assignment_id]);
    if (!query || formLoading) {
        return <div>Loading...</div>
    }
    if (query.error) {
        return <div>Error: {query.error.message}</div>
    }
    return <div>
        Autograder
        <form onSubmit={(e) => {
            e.preventDefault();
            handleSubmit(onSubmit)(e);
        }}>
            <Fieldset.Root size="lg" maxW="md">
                <Fieldset.Content>
                    <Field label="Autograder configuration for this assignment"
                        errorText={errors.enabled?.message?.toString()}
                        invalid={errors.enabled ? true : false}
                    >
                        <Controller
                            name="assignments.has_autograder"
                            control={control}
                            render={({ field }) => (
                                <RadioGroup.Root name={field.name} value={field.value ? "true" : "false"} onValueChange={field.onChange}>
                                    <Radio value="true">Enabled</Radio>
                                    <Radio value="false">Disabled</Radio>
                                </RadioGroup.Root>
                            )} />

                    </Field>
                </Fieldset.Content>
                <Fieldset.Content>
                    <Field label="Solution Repository" helperText="The repository that contains the solution code for this assignment. This repository must contain a `pawtograder.yml` file at its root.">
                        <Controller
                            name="grader_repo"
                            control={control}
                            render={({ field }) => {
                                console.log(field.value)
                                return <RepoSelector name={field.name} value={field.value} onBlur={field.onBlur}
                                    onChange={(repo) => {
                                        setGraderRepo(repo);
                                        field.onChange(repo);
                                    }}
                                />
                            }} />
                    </Field>
                </Fieldset.Content>
            </Fieldset.Root>
            <Button type="submit">Save</Button>
        </form>
        <AutograderConfiguration graderRepo={graderRepo} />

    </div>
}