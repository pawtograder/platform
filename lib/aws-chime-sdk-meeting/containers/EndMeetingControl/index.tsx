// Copyright 2020-2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import React, { useState } from "react";
import {
  ControlBarButton,
  Phone,
  Modal,
  ModalBody,
  ModalHeader,
  ModalButton,
  ModalButtonGroup,
  useLogger
} from "amazon-chime-sdk-component-library-react";

import { StyledP } from "./Styled";
import { useParams } from "next/navigation";
import { liveMeetingEnd } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";

const EndMeetingControl: React.FC = () => {
  const logger = useLogger();
  const [showModal, setShowModal] = useState(false);
  const [isEndingMeeting, setIsEndingMeeting] = useState(false);
  const toggleModal = (): void => setShowModal(!showModal);
  const { help_request_id, course_id } = useParams();
  const supabase = createClient();

  const leaveMeeting = async (): Promise<void> => {
    // Close the current window since this is the meeting interface
    window.close();
  };

  const endMeetingForAll = async (): Promise<void> => {
    if (isEndingMeeting) return;

    setIsEndingMeeting(true);
    try {
      if (help_request_id && course_id) {
        await liveMeetingEnd(
          {
            courseId: parseInt(course_id as string),
            helpRequestId: parseInt(help_request_id as string)
          },
          supabase
        );
        // Close the current window after ending the meeting
        window.close();
      } else {
        throw new Error("Missing help request or course information");
      }
    } catch (e) {
      logger.error(`Could not end meeting: ${e}`);
    } finally {
      setIsEndingMeeting(false);
    }
  };

  return (
    <>
      <ControlBarButton icon={<Phone />} onClick={toggleModal} label="Leave" />
      {showModal && (
        <Modal size="md" onClose={toggleModal} rootId="modal-root">
          <ModalHeader title="End Meeting" />
          <ModalBody>
            <StyledP>
              Leave meeting or you can end the meeting for all. The meeting cannot be used once it ends.
            </StyledP>
          </ModalBody>
          <ModalButtonGroup
            primaryButtons={[
              <ModalButton
                key="end-meeting-for-all"
                onClick={endMeetingForAll}
                variant="primary"
                label="End meeting for all"
                disabled={isEndingMeeting}
                closesModal
              />,
              <ModalButton
                key="leave-meeting"
                onClick={leaveMeeting}
                variant="primary"
                label="Leave Meeting"
                closesModal
              />,
              <ModalButton key="cancel-meeting-ending" variant="secondary" label="Cancel" closesModal />
            ]}
          />
        </Modal>
      )}
    </>
  );
};

export default EndMeetingControl;
