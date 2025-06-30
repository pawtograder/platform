// Copyright 2020-2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import React from "react";

import { Flex, Heading, PrimaryButton } from "amazon-chime-sdk-component-library-react";

import { useAppState } from "../../providers/AppStateProvider";
import { StyledList } from "./Styled";

const MeetingDetails = () => {
  const { meetingId, toggleTheme, theme, region } = useAppState();

  return (
    <Flex container layout="fill-space-centered">
      <Flex mb="2rem" mr={{ md: "2rem" }} px="1rem">
        <Heading level={4} tag="h1" mb={2}>
          Meeting information
        </Heading>
        <StyledList>
          <dt>Meeting ID</dt>
          <dd>{meetingId}</dd>
          <dt>Hosted region</dt>
          <dd>{region}</dd>
        </StyledList>
        <PrimaryButton
          mt={4}
          label={theme === "light" ? "Dark mode" : "Light mode"}
          onClick={toggleTheme}
        ></PrimaryButton>
      </Flex>
    </Flex>
  );
};

export default MeetingDetails;
