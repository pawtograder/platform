import { Roster as ChimeRoster, RosterAttendee, RosterGroup, RosterHeader, useRosterState, useMeetingStatus } from "amazon-chime-sdk-component-library-react"
export default function Roster() {
    const { roster } = useRosterState();
    const attendees = Object.values(roster);
    const attendeeItems = attendees.map((attendee) => {
        const { chimeAttendeeId } = attendee || {};
        return <RosterAttendee key={chimeAttendeeId} attendeeId={chimeAttendeeId} />
    })
    return(
        <ChimeRoster>
            <RosterHeader title="Meeting Roster" badge={attendees.length} />
            <RosterGroup>
                {attendeeItems}
            </RosterGroup>

        </ChimeRoster>
    )

}