"use client";

import { Field } from "@/components/ui/field";
import { Radio } from "@/components/ui/radio";
import RepoSelector from "@/components/ui/repo-selector";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Fieldset, Input, RadioGroup } from "@chakra-ui/react";
import { Edit } from "@refinedev/chakra-ui";
import { useForm } from "@refinedev/react-hook-form";
import { useParams } from "next/navigation";
import { Controller } from "react-hook-form";
import { ListReposResponse } from "@/components/github/GitHubTypes";
import { useState } from "react";
import AutograderConfiguration from "@/components/ui/autograder-configuration";
import { Autograder } from "@/utils/supabase/DatabaseTypes";

export default function AutograderPage() {
    const { assignment_id } = useParams();
    const [graderRepo, setGraderRepo] = useState<ListReposResponse[0]>();
    const { refineCore: { formLoading, query },
        saveButtonProps,
        register,
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
    if (!query || formLoading) {
        return <div>Loading...</div>
    }
    if (query.error) {
        return <div>Error: {query.error.message}</div>
    }
    return <div>
        Autograder
        <form>
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
                                return <RepoSelector name={field.name} value={[field.value]} onBlur={field.onBlur}
                                    onChange={(repo) => {
                                        setGraderRepo(repo);
                                        field.onChange(repo.full_name);
                                    }}
                                />
                            }} />
                    </Field>
                </Fieldset.Content>
            </Fieldset.Root>
            <AutograderConfiguration graderRepo={graderRepo} />
        </form>

    </div>
}