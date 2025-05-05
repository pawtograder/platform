import React, { useEffect, useRef } from "react";
import { ChatBubble } from "amazon-chime-sdk-component-library-react";
import { useDataMessagesState } from "../../providers/DataMessagesProvider";
import { useAppState } from "../../providers/AppStateProvider";
import { StyledMessages } from "./Styled";
import { DataMessage } from "amazon-chime-sdk-js";

// Define a type for the parsed message content
type ParsedMessage = {
  senderName: string;
  msg: string;
};

export default function Messages() {
  const { messages } = useDataMessagesState();
  const { localUserName } = useAppState();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messages.length === 0) {
      return;
    }
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  const renderMessages = () => {
    return messages.map((message: DataMessage) => {
      // Parse the message data
      let parsedData: ParsedMessage | undefined;
      try {
        parsedData = JSON.parse(message.text());
      } catch (error) {
        console.error("Failed to parse message data:", error);
        return null; // Skip rendering if parsing fails
      }

      if (!parsedData) {
        return null;
      }

      const isSelf = parsedData.senderName === localUserName;
      const timestamp = message.timestampMs;

      return (
        <ChatBubble
          key={timestamp}
          variant={isSelf ? "outgoing" : "incoming"}
          senderName={parsedData.senderName}
          showTail={isSelf}
        >
          {parsedData.msg}
        </ChatBubble>
      );
    });
  };

  return <StyledMessages ref={scrollRef}>{renderMessages()}</StyledMessages>;
}
