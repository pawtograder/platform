'use client'
import dynamic from 'next/dynamic'
const NoSSRMeeting = dynamic(() => import('./meeting'), { ssr: false })

export default function HelpRequestMeetPage() {
    return <NoSSRMeeting />
}