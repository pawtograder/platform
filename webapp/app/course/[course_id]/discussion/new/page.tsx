'use client';

import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioCardItem, RadioCardLabel, RadioCardRoot } from "@/components/ui/radio-card";
import { toaster, Toaster } from "@/components/ui/toaster";
import { Box, Fieldset, Heading, HStack, Icon, Stack, VStack } from "@chakra-ui/react";
import { Controller, useForm } from "react-hook-form";
import { FaQuestion, FaRegStickyNote, FaChalkboardTeacher } from "react-icons/fa";
import { TbWorld } from "react-icons/tb";
import MDEditor from "@uiw/react-md-editor"
import { Button } from "@/components/ui/button";
import { useCallback } from "react";
import { createClient } from "@/utils/supabase/client";
import { useParams, useRouter } from "next/navigation";

export default function NewDiscussionThread() {
    const { course_id } = useParams();
    const router = useRouter()
    const {
        handleSubmit,
        register,
        control,
        formState: { errors, isSubmitting },
    } = useForm()
    //Form to select:
    /*
    Question or note
    Title
    Description
    Tags
    is private or public
    */
    const create = useCallback(async (values: any) => {
        async function onSubmit(values: any) {
            //Create assignment here
            const supabase = await createClient();
            const user = await supabase.auth.getUser();
            const resp = await supabase.from('discussion_threads').insert({
                subject: values.subject,
                body: values.description,
                author: user.data!.user!.id,
                instructors_only: values.visibility === 'private',
                is_question: values.postType === 'question',
                root_class_id: Number.parseInt(course_id as string),
                class: Number.parseInt(course_id as string),
            }).select('*').single();
            if (resp.error) {
                console.error(resp.error)
                throw new Error("Failed to create discussion thread")
            } else {
                const discussion = resp.data;
                router.push(`/course/${course_id}/discussion/${discussion.id}`)
            }
        }
        return toaster.promise(() => onSubmit(values), {
            success: {
                description: "Discussion thread created",
                title: "Success"
            },
            loading: {
                description: "Creating discussion thread",
                title: "Creating"
            },
            error: {
                description: "Failed to create discussion thread",
                title: "Failed"
            }
        });
    }, [course_id]);
    return (
        <Box>
            <Heading as="h1">New Discussion Thread</Heading>
            <Toaster />
            <Box>
                <form onSubmit={handleSubmit(create)}>
                    <Fieldset.Root size="lg" maxW="md">
                        <Stack>
                            <Fieldset.Legend>New post details</Fieldset.Legend>
                        </Stack>
                        <Fieldset.Content>
                            <Controller
                                control={control}
                                name="postType"
                                render={({ field }) => {
                                    return (<RadioCardRoot
                                        orientation="horizontal"
                                        align="center"
                                        justify="center"
                                        maxW="lg"
                                        name={field.name}
                                        value={field.value}
                                        onChange={field.onChange}
                                    >
                                        <RadioCardLabel>Post Type</RadioCardLabel>
                                        <VStack align="stretch">
                                            <RadioCardItem value="question"
                                                indicator={false}
                                                icon={<Icon fontSize="2xl" color="fg.muted" mb="2"><FaQuestion /></Icon>}
                                                description="If you need an answer"
                                                label="Question" />
                                            <RadioCardItem value="note" label="Note"
                                                indicator={false}
                                                icon={<Icon fontSize="2xl" color="fg.muted" mb="2"><FaRegStickyNote /></Icon>}
                                                description="If you do not need an answer" />
                                        </VStack>
                                    </RadioCardRoot>)
                                }} />
                        </Fieldset.Content>
                        <Fieldset.Content>
                            <Controller
                                control={control}
                                name="visibility"
                                render={({ field }) => {
                                    return (<RadioCardRoot
                                        orientation="horizontal"
                                        align="center"
                                        justify="center"
                                        maxW="lg"
                                        name={field.name}
                                        value={field.value}
                                        onChange={field.onChange}
                                    >
                                        <RadioCardLabel>Post Visibility</RadioCardLabel>
                                        <VStack align="stretch">
                                            <RadioCardItem value="private"
                                                indicator={false}

                                                icon={<Icon fontSize="2xl" color="fg.muted" mb="2"><FaChalkboardTeacher /></Icon>}
                                                description="Only instructors can see this post. Good if you need to share private assignment details."
                                                label="Instructors only" />
                                            <RadioCardItem value="note" label="Entire Class"
                                                indicator={false}
                                                icon={<Icon fontSize="2xl" color="fg.muted" mb="2"><TbWorld /></Icon>}
                                                description="Fastest response - other students can provide support." />
                                        </VStack>
                                    </RadioCardRoot>)
                                }} />
                        </Fieldset.Content>
                        <Fieldset.Content>
                            <Field label="Subject"
                                helperText="A short, descriptive subject for your post. Be specific."
                                errorText={errors.title?.message?.toString()}
                                invalid={errors.title ? true : false}
                            ><Input
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
                                    name="description"
                                    control={control}
                                    render={({ field }) => {
                                        return (<MDEditor onChange={field.onChange} value={field.value} />)
                                    }} />
                            </Field>
                        </Fieldset.Content>
                        <Button type="submit" loading={isSubmitting}>Submit</Button>
                    </Fieldset.Root>
                </form>
            </Box>
        </Box>
    );
}