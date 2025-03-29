import { Roster as ChimeRoster, RosterAttendee, RosterGroup, RosterHeader, useRosterState, useMeetingStatus } from "amazon-chime-sdk-component-library-react"
import { HStack } from "@chakra-ui/react"
export default function Roster() {
    const { roster } = useRosterState();
    const attendees = Object.values(roster);
    const attendeeItems = attendees.map((attendee) => {
        const { chimeAttendeeId } = attendee || {};
        return <RosterAttendee key={chimeAttendeeId} attendeeId={chimeAttendeeId} />
    })
    return (
        <HStack>
            <RosterHeader title="Meeting Roster" badge={attendees.length} />
            {attendeeItems}
        </HStack>
    )

}