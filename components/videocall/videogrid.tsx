"use client";
import { Box } from "@chakra-ui/react";
import { VideoTileGrid } from "amazon-chime-sdk-component-library-react";

export default function VideoGrid() {
  return (
    <Box width="100%" height="calc(100vh - 150px)">
      <VideoTileGrid />
    </Box>
  );
}
