"use client";

import { useTimeZone } from "@/lib/TimeZoneProvider";
import { getTimeZoneAbbr } from "@/lib/timezoneUtils";
import { HStack, Text, VStack } from "@chakra-ui/react";
import { useMemo } from "react";

export function TimeZoneSelector() {
  const { mode, setMode, courseTimeZone } = useTimeZone();
  const browserTimeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  return (
    <VStack alignItems="flex-start" gap={4}>
      <Text fontSize="sm" color="fg.muted">
        Choose how you want to view assignment due dates and other timestamps in this course.
      </Text>

      <VStack alignItems="flex-start" gap={3} width="100%">
        <label style={{ width: "100%" }}>
          <HStack
            p={3}
            borderWidth={1}
            borderRadius="md"
            borderColor={mode === "course" ? "blue.500" : "border"}
            bg={mode === "course" ? "blue.subtle" : "bg.subtle"}
            cursor="pointer"
            _hover={{ bg: mode === "course" ? "blue.subtle" : "bg.muted" }}
          >
            <input
              type="radio"
              name="timezone-mode"
              value="course"
              checked={mode === "course"}
              onChange={(e) => setMode(e.target.value as "course" | "browser")}
            />
            <VStack alignItems="flex-start" gap={1} flex={1}>
              <Text fontWeight="medium" color="fg.default">
                Course time zone ({getTimeZoneAbbr(courseTimeZone)})
              </Text>
              <Text fontSize="sm" color="fg.muted">
                Show all times in the course&apos;s configured time zone: {courseTimeZone}
              </Text>
            </VStack>
          </HStack>
        </label>

        <label style={{ width: "100%" }}>
          <HStack
            p={3}
            borderWidth={1}
            borderRadius="md"
            borderColor={mode === "browser" ? "blue.500" : "border"}
            bg={mode === "browser" ? "blue.subtle" : "bg.subtle"}
            cursor="pointer"
            _hover={{ bg: mode === "browser" ? "blue.subtle" : "bg.muted" }}
          >
            <input
              type="radio"
              name="timezone-mode"
              value="browser"
              checked={mode === "browser"}
              onChange={(e) => setMode(e.target.value as "course" | "browser")}
            />
            <VStack alignItems="flex-start" gap={1} flex={1}>
              <Text fontWeight="medium">Your local time zone ({getTimeZoneAbbr(browserTimeZone)})</Text>
              <Text fontSize="sm" color="fg.muted">
                Automatically convert all times to your browser&apos;s time zone: {browserTimeZone}
              </Text>
            </VStack>
          </HStack>
        </label>
      </VStack>

      <Text fontSize="xs" color="fg.muted">
        All displayed times will clearly show which time zone is being used. Your preference is saved locally in your
        browser.
      </Text>
    </VStack>
  );
}
