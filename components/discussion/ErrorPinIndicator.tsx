"use client";

import { Badge, HStack, Icon, Text } from "@chakra-ui/react";
import { FaExclamationCircle } from "react-icons/fa";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/utils/supabase/client";
import { useParams } from "next/navigation";

interface ErrorPinIndicatorProps {
  discussion_thread_id: number;
  onClick: () => void;
}

/**
 * Component that displays a badge showing the number of active error pins
 * attached to a discussion thread. Only visible to instructors/graders.
 */
export function ErrorPinIndicator({ discussion_thread_id, onClick }: ErrorPinIndicatorProps) {
  const { course_id } = useParams();
  
  const { data: pinCount = 0 } = useQuery({
    queryKey: ["error_pins_count", discussion_thread_id, course_id],
    queryFn: async () => {
      const supabase = createClient();
      const { count, error } = await supabase
        .from("error_pins")
        .select("*", { count: "exact", head: true })
        .eq("discussion_thread_id", discussion_thread_id)
        .eq("class_id", Number(course_id))
        .eq("enabled", true);
      
      if (error) throw error;
      return count || 0;
    },
    enabled: !!discussion_thread_id && !!course_id
  });

  if (pinCount === 0) {
    return null;
  }

  return (
    <Badge
      colorPalette="blue"
      cursor="pointer"
      onClick={onClick}
      _hover={{ opacity: 0.8 }}
    >
      <HStack gap={1}>
        <Icon as={FaExclamationCircle} fontSize="xs" />
        <Text fontSize="xs">
          {pinCount} Error Pin{pinCount !== 1 ? "s" : ""}
        </Text>
      </HStack>
    </Badge>
  );
}
