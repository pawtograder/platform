'use client'
import { createContext, useCallback, useContext, useEffect, useState } from "react"
import { RealtimeChannel } from "@supabase/supabase-js"
import { createClient } from "@/utils/supabase/client"
import useAuthState from "@/hooks/useAuthState"
import { HelpRequest, HelpRequestMessage } from "@/utils/supabase/DatabaseTypes"
import { useCreate, useList } from "@refinedev/core"
export type ChatMessage = {
    id: number | string
    message: string
    created_at: string
    author: string
}
export type ChatChannelContextType = {
    messages: ChatMessage[]
    postMessage: (message: string) => Promise<void>
    participants: string[]
}
const ChatChannelContext = createContext<ChatChannelContextType | undefined>(undefined)
export const useChatChannel = () => {
    const ctx = useContext(ChatChannelContext)
    if (!ctx) {
        throw new Error('useChatChannel must be used within a ChatChannelProvider')
    }
    return ctx
}
export function HelpRequestChatChannelProvider({ help_request, children }: { help_request: HelpRequest, children: React.ReactNode }) {
    const user = useAuthState()
    const [participants, setParticipants] = useState<string[]>([])
    const { data: help_request_messages } = useList<HelpRequestMessage>({
        resource: "help_request_messages",
        filters: [
            { field: "help_request_id", operator: "eq", value: help_request.id }
        ],
        pagination: {
            pageSize: 1000
        },
        sorters: [{ field: "created_at", order: "asc" }]
    })
    const { mutateAsync: createMessage } = useCreate<HelpRequestMessage>({
        resource: "help_request_messages",
    })
    const helpRequestID = help_request.id;
    const userID = user?.id;
    useEffect(() => {
        console.log("HelpRequestID", helpRequestID)
        const supabase = createClient();

        const chan = supabase.realtime.channel(`help_request_${helpRequestID}`, {
            config: {
                broadcast: { self: true },
            },
        });
        chan.subscribe((status) => {
            if (status !== 'SUBSCRIBED') { return }
            const getUidsFromPresence = (presence: any) => {
                const uids = new Set<string>()
                // console.log(JSON.stringify(presence))
                Object.keys(presence).forEach((key) => {
                    if (presence[key][0]) {
                        uids.add(presence[key][0].user_id)
                    }
                })
                console.log(uids)
                return Array.from(uids)
            }
            chan.on('presence', { event: 'sync' }, () => {

                setParticipants(getUidsFromPresence(chan.presenceState()))
            })
            // console.log("Tracking user")
            console.log(userID)
            const presenceTrackStatus = chan.track({
                user_id: userID
            })
        })
        return () => {
            // console.log(helpRequestID)
            // console.log("Unsubscribing")
            // chan.unsubscribe()
        }
    }, [helpRequestID, userID])
    return (
        <ChatChannelContext.Provider value={{
            participants,
            messages: help_request_messages?.data ?? [], postMessage: async (message: string) => {
                await createMessage({
                    values: {
                        message, help_request_id: help_request.id, author: user?.id,
                        class_id: help_request.class_id,
                        requestor: help_request.creator
                    }
                })
            }
        }}>
            {children}
        </ChatChannelContext.Provider>
    )
}
export function EphemeralChatChannelProvider({ queue_id, class_id, children }: { queue_id: number, class_id: number, children: React.ReactNode }) {
    const [channel, setChannel] = useState<RealtimeChannel>()
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const user = useAuthState()
    const [participants, setParticipants] = useState<string[]>([])
    const postMessage = useCallback(async (message: string) => {
        if (!channel || !user) { return }
        channel.send({
            type: 'broadcast',
            event: 'chat_message',
            message: {
                id: crypto.randomUUID(),
                message,
                author: user.id,
                created_at: new Date().toISOString(),
            } as ChatMessage
        })
    }, [channel, user])
    useEffect(() => {
        const subscribe = async () => {
            const supabase = createClient();
            const user = await supabase.auth.getUser();
            const chan = supabase.realtime.channel(`help_queue_${class_id}_${queue_id}`, {
                config: {
                    broadcast: { self: true },
                },
            });
            chan.subscribe((status) => {
                if (status !== 'SUBSCRIBED') { return }
                setChannel(chan);
                const getUidsFromPresence = (presence: any) => {
                    const uids = new Set<string>()
                    Object.keys(presence).forEach((key) => {
                        if (presence[key][0]) {
                            uids.add(presence[key][0].user_id)
                        }
                    })
                    return Array.from(uids)
                }
                chan.on('presence', { event: 'sync' }, () => {
                    setParticipants(getUidsFromPresence(chan.presenceState()))
                })
                chan.on('broadcast', { event: 'chat_message' }, (payload) => {
                    setMessages((prev) => [...prev, payload.message as ChatMessage]);
                });
                const presenceTrackStatus = chan.track({
                    user_id: user.data.user?.id
                })
            })
        }
        subscribe()
    }, [queue_id, class_id])
    return (
        <ChatChannelContext.Provider value={{ participants, messages, postMessage }}>
            {children}
        </ChatChannelContext.Provider>
    )

}