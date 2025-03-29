import { createClient } from "@/utils/supabase/client";
import { use, useCallback, useEffect } from "react";
import { useList, useShow, useTable } from "@refinedev/core";
import { useParams } from "next/navigation";
import { useForm } from "@refinedev/react-hook-form";
import { RadioCardRoot, RadioCardItem } from "@/components/ui/radio-card";
import { Fieldset, Input, Button, Heading, Text } from "@chakra-ui/react";
import { HelpQueue } from "@/utils/supabase/DatabaseTypes";
import { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { Field } from "@/components/ui/field";
import { Controller } from "react-hook-form";
import { useRouter } from "next/navigation";
import MdEditor from "@/components/ui/md-editor";
import { useClassProfiles } from "@/hooks/useClassProfiles";
export default function HelpRequestForm() {
    const { course_id } = useParams();
    const supabase = createClient();
    const router = useRouter();
    const { refineCore: { formLoading, query },
        register,
        setValue,
        control,
        formState: { errors, isSubmitting },
        handleSubmit,
        refineCore: { onFinish } } = useForm<HelpRequest>({
            defaultValues: async () => {
                const { data: queues, error: queuesError } = await supabase.from("help_queues").select("*");
                return {
                    help_queue: queues?.[0]?.id.toString() || "",
                }
            },
            refineCoreProps: {
                resource: "help_requests",
                action: "create",
                onMutationSuccess: (data) => {
                    router.push(`/course/${course_id}/help/${data.data.help_queue}`)
                }
            }
        });
    const { data: queues, error: queuesError } = useList<HelpQueue>({
        resource: "help_queues",
        meta: {
            select: "*"
        },
        filters:
            [
                { field: "class_id", operator: "eq", value: course_id }
            ]
    });
    const { private_profile_id } = useClassProfiles();

    const onSubmit = useCallback((e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        async function populate() {
            setValue("creator", private_profile_id!)
            setValue("class_id", Number.parseInt(course_id as string))
            handleSubmit(onFinish)()
        }
        populate()
    }, [handleSubmit, onFinish, private_profile_id])
    if (query?.error) {
        return <div>Error: {query.error.message}</div>;
    }
    if (queuesError) {
        return <div>Error: {queuesError.message}</div>;
    }

    if (!query || formLoading ) {
        return <div>Loading...</div>;
    }

    return <form onSubmit={onSubmit}>
        <Heading>Request Live Help</Heading>
        <Text>Submit a request to get help from a live tutor via text or video chat.</Text>
        <Fieldset.Root size="lg" maxW="100%"> 
            <Fieldset.Content>
                <Field label="Queue" required={true} errorText={errors.help_queue?.message?.toString()} invalid={errors.help_queue ? true : false}>
                    <Controller
                        name="help_queue"
                        control={control}
                        render={({ field }) => (
                            <RadioCardRoot
                                orientation="vertical"
                                align="center"
                                justify="start"
                                maxW="4xl"
                                name={field.name}
                                value={field.value}
                                onChange={field.onChange}
                            >
                                {queues?.data?.map((queue) => (
                                    <RadioCardItem key={queue.id} 
                                    label={queue.name}
                                    colorPalette={queue.color || "gray"}
                                    indicator={true}
                                    description={queue.description}
                                    value={queue.id.toString()}
                                    />
                                ))}
                            </RadioCardRoot>
                        )}
                    />
                </Field>
            </Fieldset.Content>
            <Fieldset.Content>
                <Field label="Message" required={true} errorText={errors.request?.message?.toString()} invalid={errors.request ? true : false}>
                <Controller
                                    name="request"
                                    control={control}
                                    render={({ field }) => {
                                        return (<MdEditor
                                            style={{ width: "800px" }}
                                            onChange={field.onChange} value={field.value} />)
                                    }} />
                </Field>
            </Fieldset.Content>
        </Fieldset.Root>
        <Button type="submit" loading={isSubmitting}>Submit Request</Button>
    </form>
}