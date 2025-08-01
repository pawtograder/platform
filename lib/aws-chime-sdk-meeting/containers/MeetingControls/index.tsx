// Copyright 2020-2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import React from "react";
import {
  ControlBar,
  AudioInputVFControl,
  AudioInputControl,
  ContentShareControl,
  AudioOutputControl,
  useUserActivityState,
  VideoInputControl
} from "amazon-chime-sdk-component-library-react";

import EndMeetingControl from "../EndMeetingControl";
import { StyledControls } from "./Styled";
import { useAppState } from "../../providers/AppStateProvider";
import { Box } from "@chakra-ui/react";

const MeetingControls: React.FC = () => {
  const { isUserActive } = useUserActivityState();
  const { isWebAudioEnabled } = useAppState();

  return (
    <StyledControls className="controls" active={!!isUserActive}>
      <ControlBar className="controls-menu" layout="undocked-horizontal" showLabels>
        <Box position="relative">{isWebAudioEnabled ? <AudioInputVFControl /> : <AudioInputControl />}</Box>
        <Box position="relative">
          <VideoInputControl />
        </Box>
        <Box position="relative">
          <ContentShareControl />
        </Box>
        <Box position="relative">
          <AudioOutputControl />
        </Box>
        <EndMeetingControl />
      </ControlBar>
    </StyledControls>
  );
};

export default MeetingControls;
