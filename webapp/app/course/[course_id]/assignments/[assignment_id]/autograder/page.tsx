"use client";

import { Field } from "@/components/ui/field";
import { Radio } from "@/components/ui/radio";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Fieldset, Input, RadioGroup } from "@chakra-ui/react";
import { Edit } from "@refinedev/chakra-ui";
import { useForm } from "@refinedev/react-hook-form";
import { useParams } from "next/navigation";
import { Controller } from "react-hook-form";
type GraderConfigs = Database['public']['Tables']['grader_configs']['Row'];
export default function AutograderPage() {
    const { assignment_id } = useParams();
    const { refineCore: { formLoading, query },
        saveButtonProps,
        register,
        control,
        formState: { errors },
    } = useForm<GraderConfigs>({
        refineCoreProps: {
            action: "edit",
            resource: "grader_configs",
            id: Number.parseInt(assignment_id as string),
            meta: {
                select: "*, assignments(*)"
            }
        }
    });
    console.log(query);
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
                                <RadioGroup.Root name={field.name} value={field.value} onValueChange={field.onChange}>
                                    <Radio value="true">Enabled</Radio>
                                    <Radio value="false">Disabled</Radio>
                                </RadioGroup.Root>
                            )} />

                    </Field>
                </Fieldset.Content>
                <Fieldset.Content>
                    <Field label="Solution Repository">
                        <Input {...register("grader_repo")} />
                    </Field>
                </Fieldset.Content>
            </Fieldset.Root>
        </form>

    </div>
}