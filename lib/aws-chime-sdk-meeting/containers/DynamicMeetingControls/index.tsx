// Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import React from "react";
import {
  ControlBar,
  AudioInputControl,
  VideoInputControl,
  ContentShareControl,
  AudioOutputControl,
  useUserActivityState,
  useDeviceLabelTriggerStatus,
  DeviceLabelTriggerStatus,
  DeviceLabels
} from "amazon-chime-sdk-component-library-react";

import EndMeetingControl from "../EndMeetingControl";
import { StyledControls } from "./Styled";
import DevicePermissionControl from "../DevicePermissionControl/DevicePermissionControl";

const DynamicMeetingControls = () => {
  const { isUserActive } = useUserActivityState();
  const status = useDeviceLabelTriggerStatus();

  return (
    <StyledControls className="controls" active={!!isUserActive}>
      <ControlBar className="controls-menu" layout="undocked-horizontal" showLabels>
        {status === DeviceLabelTriggerStatus.GRANTED ? (
          <>
            <AudioInputControl />
            <VideoInputControl />
            <ContentShareControl />
            <AudioOutputControl />
          </>
        ) : (
          <DevicePermissionControl deviceLabels={DeviceLabels.AudioAndVideo} />
        )}

        <EndMeetingControl />
      </ControlBar>
    </StyledControls>
  );
};

export default DynamicMeetingControls;
