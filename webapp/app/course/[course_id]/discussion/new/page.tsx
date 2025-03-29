'use client';

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import MdEditor from "@/components/ui/md-editor";
import { RadioCardItem, RadioCardLabel, RadioCardRoot } from "@/components/ui/radio-card";
import { Toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { DiscussionTopic } from "@/utils/supabase/DatabaseTypes";
import { Box, Fieldset, Flex, Heading, Icon, Input } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { useParams, useRouter } from "next/navigation";
import { useCallback } from "react";
import { Controller } from "react-hook-form";
import { FaChalkboardTeacher, FaQuestion, FaRegStickyNote } from "react-icons/fa";
import { TbWorld } from "react-icons/tb";
import useAuthState from "@/hooks/useAuthState";
import { useClassProfiles } from "@/hooks/useClassProfiles";
export default function NewDiscussionThread() {
    const { course_id } = useParams();
    const router = useRouter()
    const {
        handleSubmit,
        setValue,
        register,
        control,
        getValues,
        formState: { errors, isSubmitting },
        refineCore,
    } = useForm({
        refineCoreProps: {
            resource: "discussion_threads",
            action: "create",
            onMutationSuccess: (data) => {
                router.push(`/course/${course_id}/discussion/${data.data.id}`)
            }
        }
    })
    const { data: topics } = useList<DiscussionTopic>({
        resource: "discussion_topics",
        sorters: [
            {
                field: "ordinal",
                order: "asc"
            }
        ],

        filters: [
            {
                field: "class_id",
                operator: "eq",
                value: Number.parseInt(course_id as string)
            }
        ]
    })
    const { private_profile_id } = useClassProfiles()
    const onSubmit = useCallback((e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        async function populate() {
            setValue("author", private_profile_id!)
            setValue("is_question", false)
            setValue("root_class_id", Number.parseInt(course_id as string))
            setValue("class_id", Number.parseInt(course_id as string))
            handleSubmit(refineCore.onFinish)()
        }
        populate()
    }, [handleSubmit, refineCore.onFinish, private_profile_id])
    return (
        <Box>
            <Heading as="h1">New Discussion Thread</Heading>
            <Toaster />
            <Box maxW="4xl">
                <form onSubmit={onSubmit}>
                    <Fieldset.Root bg="surface">
                        <Fieldset.Content w="100%">
                            <Field label="Topic" helperText={getValues("topic_id") && topics?.data?.find((topic: DiscussionTopic) => topic.id === getValues("topic_id"))?.description}
                                errorText={errors.topic_id?.message?.toString()}
                                invalid={errors.topic_id ? true : false}
                            >
                                <Controller
                                    control={control}
                                    name="topic_id"
                                    render={({ field }) => {
                                        return (<RadioCardRoot
                                            orientation="vertical"
                                            align="center"
                                            justify="start"
                                            maxW="4xl"
                                            name={field.name}
                                            value={field.value}
                                            onChange={field.onChange}    
                                        >
                                            <Flex flexWrap="wrap" gap="2">
                                                {topics?.data?.map((topic: DiscussionTopic) => (
                                                    <Box key={topic.id} w="sm">
                                                        <RadioCardItem
                                                        p="0"
                                                        m="0"
                                                            indicator={false}
                                                            colorPalette={topic.color}
                                                            description={topic.description}
                                                            value={topic.id?.toString() || ""} label={topic.topic} />
                                                    </Box>
                                                ))}
                                            </Flex>
                                        </RadioCardRoot>)
                                    }} />
                            </Field>
                        </Fieldset.Content>
                        <Fieldset.Content>
                            <Controller
                                control={control}
                                name="is_question"
                                render={({ field }) => {
                                    return (<RadioCardRoot
                                        orientation="horizontal"
                                        align="center"
                                        justify="center"
                                        maxW="4xl"
                                        name={field.name}
                                        value={field.value}
                                        onChange={field.onChange}
                                    >
                                        <RadioCardLabel>Post Type</RadioCardLabel>
                                        <Flex flexWrap="wrap" gap="2">
                                            <Box w="sm">
                                                <RadioCardItem value="true"
                                                    indicator={false}
                                                    icon={<Icon fontSize="2xl" color="fg.muted" mb="2"><FaQuestion /></Icon>}
                                                    description="If you need an answer"
                                                    label="Question" />
                                            </Box>
                                            <Box w="sm">
                                                <RadioCardItem value="false" label="Note"
                                                    indicator={false}
                                                    icon={<Icon fontSize="2xl" color="fg.muted" mb="2"><FaRegStickyNote /></Icon>}
                                                    description="If you do not need an answer" />
                                            </Box>
                                        </Flex>
                                    </RadioCardRoot>)
                                }} />
                        </Fieldset.Content>
                        <Fieldset.Content>
                            <Controller
                                control={control}
                                name="instructors_only"
                                render={({ field }) => {
                                    return (<RadioCardRoot
                                        orientation="horizontal"
                                        align="center"
                                        justify="center"
                                        maxW="4xl"
                                        name={field.name}
                                        value={field.value}
                                        onChange={field.onChange}
                                    >
                                        <RadioCardLabel>Post Visibility</RadioCardLabel>
                                        <Flex flexWrap="wrap" gap="2">
                                            <Box w="sm">
                                                <RadioCardItem value="false" label="Entire Class"
                                                    indicator={false}
                                                    icon={<Icon fontSize="2xl" color="fg.muted" mb="2"><TbWorld /></Icon>}
                                                    description="Fastest response - other students can provide support." />
                                            </Box>

                                            <Box w="sm">
                                                <RadioCardItem value="true"
                                                    indicator={false}

                                                    icon={<Icon fontSize="2xl" color="fg.muted" mb="2"><FaChalkboardTeacher /></Icon>}
                                                    description="Only instructors can see this post. Good if you need to share private assignment details."
                                                    label="Instructors only" />
                                            </Box>
                                        </Flex>
                                    </RadioCardRoot>)
                                }} />
                        </Fieldset.Content>
                        <Fieldset.Content>
                            <Field label="Subject"
                                helperText="A short, descriptive subject for your post. Be specific."
                                errorText={errors.title?.message?.toString()}
                                invalid={errors.title ? true : false}
                            ><Input
                                    variant="outline"
                                    type="text"
                                    {...register('subject', {
                                        required: 'This is required',
                                    })} /></Field>
                        </Fieldset.Content>
                        <Fieldset.Content>
                            <Field label="Description"
                                helperText="A detailed description of your post. Be specific."
                                errorText={errors.description?.message?.toString()}
                                invalid={errors.description ? true : false}
                            >
                                <Controller
                                    name="body"
                                    control={control}
                                    render={({ field }) => {
                                        return (<MdEditor
                                            style={{ width: "800px" }}
                                            onChange={field.onChange} value={field.value} />)
                                    }} />
                            </Field>
                        </Fieldset.Content>
                        <Button type="submit" loading={isSubmitting} disabled={isSubmitting}>Submit</Button>
                    </Fieldset.Root>
                </form>
            </Box>
        </Box>
    );
}