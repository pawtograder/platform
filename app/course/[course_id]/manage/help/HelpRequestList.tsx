'use client'
import { ChatGroupHeader } from '@/components/ui/help-queue/ChatGroupHeader'
import { HelpRequestTeaser } from '@/components/ui/help-queue/HelpRequestTeaser'
import { SearchInput } from '@/components/ui/help-queue/SearchInput'
import { useClassProfiles } from '@/hooks/useClassProfiles'
import { HelpRequest } from '@/utils/supabase/DatabaseTypes'
import {
    Box,
    Flex,
    Stack,
    Text
} from '@chakra-ui/react'
import { useList } from '@refinedev/core'
import NextLink from 'next/link'
import { useParams } from 'next/navigation'
import { BsChatTextFill, BsClipboardCheckFill } from 'react-icons/bs'
export default function HelpRequestList() {
    const { course_id, request_id } = useParams();
    const { private_profile_id } = useClassProfiles();
    const activeRequestID = request_id ? Number.parseInt(request_id as string) : null;

    const { data } = useList<HelpRequest>({
        resource: "help_requests",
        filters: [
            { field: "class_id", operator: "eq", value: course_id }
        ]
    })
    const requests = data?.data;
    return (
        <Flex height="100vh" overflow="hidden">
            <Stack spaceY="4" width="320px" borderEndWidth="1px" pt="6">
                <Box px="5">
                    <Text fontSize="lg" fontWeight="medium">
                        Requests ({requests?.length})
                    </Text>
                </Box>

                <Box px="5">
                    <SearchInput />
                </Box>

                <Stack mt="2" spaceY="4" flex="1" overflowY="auto" px="5" pb="5">
                    <Stack mt="2" spaceY="4">
                        <ChatGroupHeader icon={BsClipboardCheckFill}>Working ({requests?.filter(r => r.assignee === private_profile_id).length})</ChatGroupHeader>
                        <Stack spaceY="0" mx="-4">
                            {requests?.filter(r => r.assignee === private_profile_id && r.resolved_by === null).map((request) => (
                                <NextLink
                                    href={`/course/${course_id}/manage/help/request/${request.id}`}
                                    key={request.id}
                                    legacyBehavior>
                                    <HelpRequestTeaser data={{
                                        user: request.creator,
                                        updatedAt: request.created_at,
                                        message: request.request,
                                        isResolved: request.resolved_by !== null,
                                        isAssigned: request.assignee === private_profile_id
                                }}
                                    selected={activeRequestID === request.id}
                                />
                                </NextLink>
                            ))}
                        </Stack>
                    </Stack>

                    <Stack mt="2" spaceY="4">
                        <ChatGroupHeader icon={BsChatTextFill}>Unassigned ({requests?.filter(r => r.assignee === null).length})</ChatGroupHeader>
                        <Stack spaceY="0" mx="-4">
                            {requests?.filter(r => r.assignee === null && r.resolved_by === null).map((request) => (
                                <NextLink
                                    href={`/course/${course_id}/manage/help/request/${request.id}`}
                                    key={request.id}
                                    legacyBehavior>
                                    <HelpRequestTeaser data={{
                                        user: request.creator,
                                        updatedAt: request.created_at,
                                        message: request.request,
                                        isResolved: request.resolved_by !== null,
                                        isAssigned: request.assignee === private_profile_id
                                }} 
                                    selected={activeRequestID === request.id}
                                />
                                </NextLink>
                            ))}
                        </Stack>
                    </Stack>
                    <Stack mt="2" spaceY="4">
                        <ChatGroupHeader icon={BsChatTextFill}>Resolved ({requests?.filter(r => r.resolved_by !== null).length})</ChatGroupHeader>
                        <Stack spaceY="0" mx="-4">
                            {requests?.filter(r => r.resolved_by !== null).map((request) => (
                                <NextLink
                                    href={`/course/${course_id}/manage/help/request/${request.id}`}
                                    key={request.id}
                                    legacyBehavior>
                                    <HelpRequestTeaser data={{
                                        user: request.creator,
                                        updatedAt: request.created_at,
                                        message: request.request,
                                        isResolved: request.resolved_by !== null,
                                        isAssigned: request.assignee === private_profile_id
                                }} 
                                    selected={activeRequestID === request.id}
                                />
                                </NextLink>
                            ))}
                        </Stack>
                    </Stack>
                </Stack>
            </Stack>
        </Flex>
    );
}