import { Button } from "@/components/ui/button";
import Markdown from "@/components/ui/markdown";
import MessageInput from "@/components/ui/message-input";
import { Skeleton, SkeletonCircle } from "@/components/ui/skeleton";
import useAuthState from "@/hooks/useAuthState";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { DiscussionThread as DiscussionThreadType, ThreadWithChildren } from "@/utils/supabase/DatabaseTypes";
import { Avatar, Badge, Box, Container, Flex, HStack, Link, Stack, Text  } from "@chakra-ui/react";
import { useCreate, useInvalidate } from "@refinedev/core";
import { formatRelative } from "date-fns";
import { useCallback, useState } from "react";


export function threadsToTree(threads: DiscussionThreadType[]): ThreadWithChildren {
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
export function DiscussionThreadReply({ thread, visible, setVisible }: { thread: DiscussionThreadType, visible: boolean, setVisible: (visible: boolean) => void }) {

    const invalidate = useInvalidate();
    const { mutateAsync: mutate } = useCreate({
        resource: "discussion_threads",
    });
    const sendMessage = useCallback(async (message: string, profile_id: string, close = true) => {
        console.log("sendMessage", message);
        
        await mutate({
            resource: "discussion_threads",
            values: {
                subject: `Re: ${thread.subject}`,
                parent: thread.id,
                root: thread.root || thread.id,
                topic_id: thread.topic_id,
                instructors_only: thread.instructors_only,
                class_id: thread.class_id,
                author: profile_id,
                body: message
            }
        });
        invalidate({
            resource: "discussion_threads",
            invalidates: ['detail'],
            id: thread.parent!
        });
        if (close) {
            setVisible(false);
        }
    }, [mutate, thread]);
    if (!visible) {
        return <></>
    }
    return <Container ml="2" w="100%" bg="bg.subtle" p="2"
        rounded="l3" py="2" px="3"
    >
        <MessageInput defaultSingleLine={true}
            sendMessage={sendMessage}
        />
        <Button variant="ghost" onClick={() => setVisible(false)}>Cancel</Button>
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
    const authorProfile = useUserProfile(thread.author);

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
    return <Container pl="8" pr="0" alignSelf="flex-start">


        <Box pos="relative" w="100%" pt="2">
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
                {authorProfile ? <Avatar.Root size="sm" variant="outline" shape="square">
                    <Avatar.Fallback name={authorProfile!.name} />
                    <Avatar.Image src={authorProfile!.avatar_url} />
                </Avatar.Root> : <SkeletonCircle size="sm" />}
                <Stack w="100%">
                    <Box bg="bg.muted" rounded="l3" py="2" px="3">
                        <HStack gap="1">
                            <Text textStyle="sm" fontWeight="semibold">
                                <Link id={`post-${thread.ordinal}`} href={`/course/${thread.class_id}/discussion/${thread.root}#post-${thread.ordinal}`}>#{thread.ordinal}</Link>
                            </Text>
                            {authorProfile ? <Text textStyle="sm" fontWeight="semibold">
                                {authorProfile?.name}
                                {thread.author === originalPoster && <Badge ml="2" colorPalette="blue">OP</Badge>}
                                {authorProfile?.flair && <Badge ml="2" colorPalette={authorProfile?.flair_color}>{authorProfile?.flair}</Badge>}
                            </Text> : <Skeleton width="100px" />}
                        </HStack>
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