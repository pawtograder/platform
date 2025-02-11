import { Database } from "@/utils/supabase/SupabaseTypes";
import { Button, HStack, Icon } from "@chakra-ui/react";
import { Card } from "@chakra-ui/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FaCheckCircle, FaHeart, FaQuestion, FaQuestionCircle, FaRegComment, FaRegHeart, FaRegStickyNote, FaReply } from "react-icons/fa";
import Markdown from 'react-markdown'

type Thread = Database['public']['Tables']['discussion_threads']['Row'];

export function Snackbar({ thread, reply }: { thread: Thread, reply?: () => void }) {
    return (
    <HStack>

    <Button variant="outline" rounded="full">
        <Icon as={FaRegHeart} /> {thread.likes_count || 0}
    </Button>
    <Button variant="outline" rounded="full" aria-label="Reply" onClick={reply}>
        <Icon as={FaReply} /> {thread.children_count || 0}
    </Button>
    </HStack>)
}
export function DiscussionPostSummary({ thread }: { thread: Thread }) {
    const router = useRouter();
    const getIcon = () => {
        if (thread.is_question) {
            if (thread.answer) {
                return <Icon as={FaCheckCircle} />
            }
            return <Icon as={FaQuestionCircle} />
        }
        return <Icon as={FaRegStickyNote} />
    }
    return <Link href={`/course/${thread.class}/discussion/${thread.id}`}><Card.Root
        _hover={{
            bg: "gray.50",
            cursor: "pointer"
        }}
    >
        <Card.Title>
            {getIcon()}
            {thread.subject}</Card.Title>
        <Card.Header>
            {thread.author} at {thread.created_at}
        </Card.Header>
        <Card.Body>
            <Markdown>{thread.body}</Markdown>
        </Card.Body>
        <Card.Footer>
            <Snackbar thread={thread} reply={() => router.push(`/course/${thread.class}/discussion/${thread.id}`)} />
        </Card.Footer>
    </Card.Root></Link>
}