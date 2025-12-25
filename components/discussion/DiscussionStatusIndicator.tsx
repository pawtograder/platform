"use client";

import { Icon } from "@chakra-ui/react";
import { FaCheck, FaCircle } from "react-icons/fa";

export function DiscussionStatusIndicator({
  isUnread,
  hasUnreadReplies
}: {
  isUnread: boolean;
  hasUnreadReplies: boolean;
}) {
  if (isUnread) {
    return <Icon as={FaCircle} color="blue.500" boxSize="2" />;
  }
  if (hasUnreadReplies) {
    return <Icon as={FaCircle} color="orange.400" boxSize="2" />;
  }
  return <Icon as={FaCheck} color="gray.400" boxSize="3" />;
}
