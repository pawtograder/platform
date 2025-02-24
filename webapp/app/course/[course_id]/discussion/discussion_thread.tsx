import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { createClient } from "@/utils/supabase/client";
import { DiscussionThreadWithAuthorAndTopic, ThreadWithChildren } from "@/utils/supabase/DatabaseTypes";
import { Avatar, Badge, Box, Container, Fieldset, Flex, HStack, Link, Stack, Text } from "@chakra-ui/react";
import { useForm } from "@refinedev/react-hook-form";
import MDEditor from "@uiw/react-md-editor";
import { formatRelative } from "date-fns";
import { useCallback, useState } from "react";
import { Controller } from "react-hook-form";
import Markdown from "react-markdown";


export function threadsToTree(threads: DiscussionThreadWithAuthorAndTopic[]): ThreadWithChildren {
    const threadMap = new Map<number, ThreadWithChildren>();
    let root: ThreadWithChildren | undefined;
    for (const thread of threads) {
        threadMap.set(thread.id, { ...thread, children: [] });
    }
    for (const thread of threads) {
        if (thread.parent && thread.parent !== thread.id) {
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
export function DiscussionThreadReply({ thread, visible, setVisible }: { thread: DiscussionThreadWithAuthorAndTopic, visible: boolean, setVisible: (visible: boolean) => void }) {
    const {
        getValues,
        setValue,
        refineCore,
        handleSubmit,
        control,
        formState: { errors, isSubmitting },
    } = useForm({
        refineCoreProps: {
            action: "create",
            resource: "discussion_threads",
            onMutationSuccess: () => {
                setVisible(false);
            }
        }
    });
    const onSubmit = useCallback((e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        async function populate() {
            setValue("subject", `Re: ${thread.subject}`)
            setValue("parent", thread.id)
            setValue("root", thread.root || thread.id)
            setValue("topic_id", thread.topic_id)
            setValue("instructors_only", thread.instructors_only)
            setValue("class", thread.class)
            const supabase = await createClient();
            const user = await supabase.auth.getUser();
            setValue("author", user.data!.user!.id)
            handleSubmit(refineCore.onFinish)();
        }
        populate();
    }, [getValues, handleSubmit, refineCore, setValue, thread]);


    if (!visible) {
        return <></>
    }
    return <Container ml="2" w="100%" bg="bg.muted" p="2"
    rounded="l3" py="2" px="3"
    >
            <form onSubmit={onSubmit}>
                <Fieldset.Root size="lg" maxW="100%">
                    <Fieldset.Content>
                        <Field label="Reply"
                            errorText={errors.body?.message?.toString()}
                            invalid={errors.body ? true : false}
                        >
                            <Controller
                                name="body"
                                control={control}
                                rules={{
                                    required: {
                                        message: "Please enter a message or click cancel",
                                        value: true
                                    }
                                }}
                                render={({ field }) => {
                                    return (<MDEditor style={{ width: "100%" }} onChange={field.onChange} value={field.value} />)
                                }} />
                        </Field>
                    </Fieldset.Content>

                </Fieldset.Root>

                <HStack justify="flex-end">
                    <Button variant="ghost" onClick={() => setVisible(false)}>Cancel</Button>
                    <Button type="submit">Submit</Button>
                </HStack>
            </form>
    </Container>
}
export function DiscussionThread({ thread, borders, originalPoster }: {
    thread: ThreadWithChildren, borders:
    {
        indent: boolean,
        descendant: boolean, // whether this thread has children
        outerSiblings: boolean[], // whether this thread has siblings, at each level
        isFirstDescendantOfParent: boolean, // whether this thread is the first child of its parent
    },
    originalPoster: string
}) {
    const [replyVisible, setReplyVisible] = useState(false);

    const outerBorders = (present: boolean[]): JSX.Element => {
        let ret: JSX.Element[] = []
        for (let i = 0; i < present.length; i++) {
            if (present[i]) {
                ret.push(<Box
                    key={i}
                    pos="absolute" width="2px" left={`${(present.length - i - 2) * -32}px`}
                    top={i == present.length - 1 && borders.isFirstDescendantOfParent ? "0" : "0"} bottom="0" bg="border" />)
            }
        }
        return <>{ret}</>
    }
    return <Container alignSelf="flex-start">


        <Box pos="relative" w="xl" pt="2">
            <Box
                pos="absolute"
                width="5"
                height="8"
                left="8"
                top="0"
                bottom="0"
                borderColor="border"
                roundedBottomLeft="l3"
                borderStartWidth="2px"
                borderBottomWidth="2px"
            />
            {outerBorders(borders.outerSiblings,)}
            {borders.descendant && <Box
                pos="absolute" width="2px" left="16" top="10" bottom="0" bg="border" />}
            <Flex gap="2" ps="14" pt="2" as="article" tabIndex={-1} w="100%">
                <Avatar.Root size="sm" variant="outline" shape="square">
                    <Avatar.Fallback name={thread.public_profiles.name} />
                    <Avatar.Image src={`https://api.dicebear.com/9.x/identicon/svg?seed=${thread.public_profiles.name}`} />
                </Avatar.Root>
                <Stack w="100%">
                    <Box bg="bg.muted" rounded="l3" py="2" px="3">
                        <Text textStyle="sm" fontWeight="semibold">
                            {thread.public_profiles.name}
                            {thread.author === originalPoster && <Badge ml="2" colorPalette="blue">OP</Badge>}
                            {thread.public_profiles.is_instructor && <Badge ml="2" colorPalette="red">Instructor</Badge>}
                        </Text>
                        <Box textStyle="sm" color="fg.muted">
                            <Markdown>{thread.body}</Markdown>
                        </Box>
                    </Box>
                    <HStack fontWeight="semibold" textStyle="xs" ps="2">
                        <Text textStyle="sm" color="fg.muted" ms="3">
                            {formatRelative(thread.created_at, new Date())}
                        </Text>
                        <Text color="fg.muted">Like</Text>
                        <Link onClick={() => setReplyVisible(true)} color="fg.muted">Reply</Link>
                    </HStack>
                        <DiscussionThreadReply thread={thread} visible={replyVisible} setVisible={setReplyVisible} />
                </Stack>
            </Flex>
        </Box>
        {/* <Box w="100%" pl="4em"> */}
        {
            thread.children.map((child, index) =>
                <DiscussionThread key={child.id} thread={child}
                    borders={{
                        indent: index === 0,
                        descendant: child.children.length > 0,
                        outerSiblings: borders.outerSiblings.concat(thread.children.length > 1 && index !== thread.children.length - 1 ? [true] : [false]),
                        isFirstDescendantOfParent: index === 0
                    }}
                    originalPoster={originalPoster}
                />)
        }
        {/* </Box> */}
    </Container>
}