"use client";

import { Badge, HStack, Icon, Text } from "@chakra-ui/react";
import { FaExclamationCircle } from "react-icons/fa";
import { createClient } from "@/utils/supabase/client";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

interface ErrorPinIndicatorProps {
  discussion_thread_id: number;
  onClick: () => void;
  refreshTrigger?: number;
}

/**
 * Component that displays a badge showing the number of active error pins
 * attached to a discussion thread. Only visible to instructors/graders.
 */
export function ErrorPinIndicator({ discussion_thread_id, onClick, refreshTrigger }: ErrorPinIndicatorProps) {
  const { course_id } = useParams();
  const [pinCount, setPinCount] = useState(0);

  const fetchPinCount = useCallback(async () => {
    if (!discussion_thread_id || !course_id) return;

    const supabase = createClient();
    const { count, error } = await supabase
      .from("error_pins")
      .select("*", { count: "exact", head: true })
      .eq("discussion_thread_id", discussion_thread_id)
      .eq("class_id", Number(course_id))
      .eq("enabled", true);

    if (error) {
      console.error("Error fetching pin count:", error);
      return;
    }
    setPinCount(count || 0);
  }, [discussion_thread_id, course_id]);

  useEffect(() => {
    fetchPinCount();
  }, [fetchPinCount, refreshTrigger]);

  if (pinCount === 0) {
    return null;
  }

  return (
    <Badge colorPalette="blue" cursor="pointer" onClick={onClick} _hover={{ opacity: 0.8 }}>
      <HStack gap={1}>
        <Icon as={FaExclamationCircle} fontSize="xs" />
        <Text fontSize="xs">
          {pinCount} Error Pin{pinCount !== 1 ? "s" : ""}
        </Text>
      </HStack>
    </Badge>
  );
}
