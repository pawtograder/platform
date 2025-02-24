'use client'
import { Box } from '@chakra-ui/react';
import { MeetingStatus, useMeetingManager, VideoTileGrid } from 'amazon-chime-sdk-component-library-react';

export default function VideoGrid() {
    const meetingManager = useMeetingManager();

    return <Box width="100%" height="500px">
        Video tile grid?
            <VideoTileGrid 
            />
    </Box>
}