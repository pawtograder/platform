import { DiscussionThreadWithAuthorAndTopic } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import {
    Avatar,
    Badge, Box, Button, Container,
    Flex, HStack, Icon, Spacer,
    Stack,
    Status,
    Text,
    VStack
} from "@chakra-ui/react";
import excerptAst from "mdast-excerpt"

import Link from "next/link";
import { useRouter } from "next/navigation";
import { BsChat, BsChevronUp } from 'react-icons/bs';
import { FaCheckCircle, FaQuestionCircle, FaRegHeart, FaRegStickyNote, FaReply } from "react-icons/fa";
import { RxQuestionMarkCircled } from "react-icons/rx";

import Markdown from "react-markdown";
import { formatRelative } from "date-fns";
import { ThreadWithChildren } from "@/utils/supabase/DatabaseTypes";
import { DiscussionThread, DiscussionThreadReply } from "@/app/course/[course_id]/discussion/discussion_thread";
import { useState } from "react";
export function DiscussionPostSummary({ thread, standalone }: {
    thread: DiscussionThreadWithAuthorAndTopic | ThreadWithChildren,
    standalone?: boolean
}) {
    const router = useRouter();
    const [replyVisible, setReplyVisible] = useState(false);
    const getIcon = () => {
        if (thread.is_question) {
            if (thread.answer) {
                return <Icon as={FaCheckCircle} />
            }
            return <Icon as={RxQuestionMarkCircled} />
        }
        return <Icon as={FaRegStickyNote} />
    }
    const comments = <HStack> <BsChat />
        <Text textStyle="sm" color="fg.muted">
            {thread.children_count}
        </Text></HStack>
    return <Box>

        <Flex borderWidth="1px" divideX="1px" borderRadius="l3" bg="bg"
            _hover={{
                bg: standalone ? 'bg' : 'bg.subtle'
            }}>
            <Stack p="6" flex="1">
                <Badge variant="surface" alignSelf="flex-start" colorPalette={thread.discussion_topics.color}>
                    {thread.discussion_topics.topic}
                    {getIcon()}
                </Badge>
                <Text textStyle="lg" fontWeight="semibold" mt="2">
                    {thread.subject}
                </Text>
                <Markdown components={{
                    a: ({ children, href }) => {
                        if (!href || !standalone) {
                            return <>{children}</>
                        }
                        return <Link href={href} target="_blank">{children}</Link>
                    }
                }}>{thread.body}</Markdown>

                <HStack fontWeight="medium" mt="4">
                    <HStack>
                        <Avatar.Root size="sm" variant="outline" shape="square">
                            <Avatar.Fallback name={thread.public_profiles.username} />
                            <Avatar.Image src={`https://api.dicebear.com/9.x/identicon/svg?seed=${thread.public_profiles.username}`} />
                        </Avatar.Root>
                        <Text textStyle="sm" hideBelow="sm">
                            {thread.public_profiles.username}
                        </Text>
                    </HStack>
                    <Text textStyle="sm" color="fg.muted" ms="3">
                        {formatRelative(thread.created_at, new Date())}
                    </Text>
                    <Spacer />

                    <HStack gap="4">
                        <HStack gap="1">
                            {standalone && <Button variant="ghost" onClick={() => setReplyVisible(true)}>{comments}</Button>}

                        </HStack>
                        <Status.Root hideBelow="sm">
                            <Status.Indicator />
                            {/* {thread.topic} */}
                        </Status.Root>
                    </HStack>
                </HStack>
            </Stack>
            <VStack px="4" justify="center" flexShrink="0">
                <BsChevronUp />
                <Text textStyle="sm" fontWeight="semibold">
                    {thread.likes_count}
                </Text>
            </VStack>
        </Flex>
        <DiscussionThreadReply thread={thread} visible={replyVisible && standalone === true} setVisible={setReplyVisible} />
        {
            (thread as ThreadWithChildren).children && (thread as ThreadWithChildren).children.map((child, index) => (
                <DiscussionThread key={child.id} thread={child}
                    borders={{
                        indent: false,
                        outerSiblings: (thread as ThreadWithChildren).children.length > 1 && index !== (thread as ThreadWithChildren).children.length - 1 ? [true] : [false],
                        descendant: child.children_count > 0,
                        isFirstDescendantOfParent: index === 0,
                    }}
                    originalPoster={thread.author}
                />
            ))
        }
    </Box >
}