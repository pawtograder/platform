// Copyright 2020-2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { createMeetingAndAttendee } from "../../utils/api";
import { AMAZON_CHIME_VOICE_CONNECTOR_PHONE_NUMDER } from "../../constants";

export class SIPMeetingManager {
  private region: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private meetingData: any = null;

  constructor(region = "us-east-1") {
    this.region = region;
  }

  getSIPURI = async (meetingId: string, voiceConnectorId: string): Promise<string> => {
    try {
      this.meetingData = await createMeetingAndAttendee(
        meetingId,
        AMAZON_CHIME_VOICE_CONNECTOR_PHONE_NUMDER,
        this.region
      );
      const joinToken = this.meetingData.JoinInfo.Attendee.JoinToken;
      return `sip:${AMAZON_CHIME_VOICE_CONNECTOR_PHONE_NUMDER}@${voiceConnectorId};transport=tls;X-joinToken=${joinToken}`;
    } catch (error) {
      throw new Error((error as Error).message);
    }
  };
}
