import { Button } from "@/components/ui/button";
import { Snackbar } from "@/components/ui/discussion-post-summary";
import { Field } from "@/components/ui/field";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Card, Fieldset, HStack, Icon, VStack } from "@chakra-ui/react";
import MDEditor from "@uiw/react-md-editor";
import { useCallback, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { FaRegStickyNote } from "react-icons/fa";
import { FaQuestionCircle } from "react-icons/fa";
import { FaCheckCircle } from "react-icons/fa";
import Markdown from "react-markdown";

export type ThreadWithChildren = Database['public']['Tables']['discussion_threads']['Row'] & {
    children: ThreadWithChildren[]
}
export function threadsToTree(threads: Database['public']['Tables']['discussion_threads']['Row'][]): ThreadWithChildren {
    const threadMap = new Map<number, ThreadWithChildren>();
    let root: ThreadWithChildren | undefined;
    for (const thread of threads) {
        threadMap.set(thread.id, { ...thread, children: [] });
    }
    for (const thread of threads) {
        if (thread.parent) {
            const parent = threadMap.get(thread.parent);
            if (parent) {
                parent.children.push(threadMap.get(thread.id)!);
            }
        } else {
            root = threadMap.get(thread.id);
        }
    }
    if (!root) {
        throw new Error("No root thread found");
    }
    return root;
}
export function DiscussionThreadReply({ thread, visible, setVisible }: { thread: ThreadWithChildren, visible: boolean, setVisible: (visible: boolean) => void }) {
    const {
        handleSubmit,
        register,
        control,
        formState: { errors, isSubmitting },
    } = useForm()

    const create = useCallback(async (values: any) => {
        async function onSubmit(values: any) {
            console.log(values)
            //Create assignment here
            const supabase = await createClient();
            const user = await supabase.auth.getUser();
            const resp = await supabase.from('discussion_threads').insert({
                subject: 'Re: ' + thread.subject,
                body: values.description,
                author: user.data!.user!.id,
                instructors_only: thread.instructors_only,
                class: thread.class,
                parent: thread.id,
                root: thread.root || thread.id
            });
            if (resp.error) {
                console.error(resp.error)
                throw new Error("Failed to create discussion thread")
            }
        }
        return toaster.promise(() => onSubmit(values), {
            success: {
                description: "Reply created",
                title: "Success"
            },
            loading: {
                description: "Creating reply",
                title: "Creating"
            },
            error: {
                description: "Failed to create reply",
                title: "Failed"
            }
        });
    }, [thread]);
    if (!visible) {
        return <></>
    }
    return <Card.Root w="100%">
        <Card.Title>Reply</Card.Title>
        <Card.Body>
            <form onSubmit={handleSubmit(create)}>
                <Fieldset.Root size="lg" maxW="100%">
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
                                    return (<MDEditor style={{width: "100%"}} onChange={field.onChange} value={field.value} />)
                                }} />
                        </Field>
                    </Fieldset.Content>

                </Fieldset.Root>

                <HStack>
                    <Button type="submit">Submit</Button>
                    <Button variant="ghost" onClick={() => setVisible(false)}>Cancel</Button>
                </HStack>
            </form>
        </Card.Body>
    </Card.Root>
}
export function DiscussionThread({ thread}: { thread: ThreadWithChildren }) {
    const [replyVisible, setReplyVisible] = useState(false);
    const getIcon = () => {
        if (thread.is_question) {
            if (thread.answer) {
                return <Icon as={FaCheckCircle} />
            }
            return <Icon as={FaQuestionCircle} />
        }
        return <Icon as={FaRegStickyNote} />
    }
    return <VStack>
        <Card.Root w="100%">
            <Card.Title>{getIcon()} {thread.subject}</Card.Title>
            <Card.Header>{thread.author} at {new Date(thread.created_at).toLocaleString()}</Card.Header>
            <Card.Body>
                <Markdown>{thread.body}</Markdown>
                <Snackbar thread={thread} reply={() => setReplyVisible(true)} />
                <DiscussionThreadReply thread={thread} visible={replyVisible} setVisible={setReplyVisible} />
            </Card.Body>
        </Card.Root>
        <Box w="100%" pl="4em">
            {
                thread.children.map((child) => <DiscussionThread key={child.id} thread={child} />)
            }
        </Box>
    </VStack>
}