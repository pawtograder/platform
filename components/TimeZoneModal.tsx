"use client";

import { Button } from "@/components/ui/button";
import {
  DialogActionTrigger,
  DialogBackdrop,
  DialogBody,
  DialogCloseTrigger,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle
} from "@/components/ui/dialog";
import { useTimeZone } from "@/lib/TimeZoneProvider";
import { Box, HStack, Icon, Text, VStack } from "@chakra-ui/react";
import { FiClock, FiGlobe } from "react-icons/fi";

export function TimeZoneModal() {
  const { showModal, courseTimeZone, browserTimeZone, mode, setMode, dismissModal } = useTimeZone();

  if (!showModal) {
    return null;
  }

  // Format timezone names for display
  const formatTimeZoneName = (tz: string) => {
    try {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat("en", {
        timeZone: tz,
        timeZoneName: "short"
      });
      const parts = formatter.formatToParts(now);
      const abbr = parts.find((part) => part.type === "timeZoneName")?.value || "";
      const cityName = tz.split("/").pop()?.replace(/_/g, " ") || tz;
      return `${cityName} (${abbr})`;
    } catch {
      return tz;
    }
  };

  return (
    <DialogRoot open={showModal} onOpenChange={() => dismissModal()} size="md">
      <DialogBackdrop />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Choose Your Time Zone Preference</DialogTitle>
        </DialogHeader>

        <DialogBody>
          <VStack gap={4} align="stretch">
            <Text color="fg.muted" fontSize="sm">
              This course is set to <strong>{formatTimeZoneName(courseTimeZone)}</strong>, but your browser is set to{" "}
              <Text fontWeight="medium">{formatTimeZoneName(browserTimeZone)}.</Text>
            </Text>

            <Text color="fg.muted" fontSize="sm">
              How would you like to view assignment due dates and other times?
            </Text>

            <VStack gap={3} align="stretch">
              {/* Course timezone option */}
              <Box as="label" display="block" cursor="pointer">
                <HStack
                  p={4}
                  border="1px solid"
                  borderColor="border.muted"
                  borderRadius="md"
                  _hover={{ borderColor: "border.emphasized", bg: "bg.subtle" }}
                  gap={3}
                >
                  <input
                    type="radio"
                    name="timezone-preference"
                    value="course"
                    checked={mode === "course"}
                    onChange={(e) => setMode(e.target.value as "course" | "browser")}
                  />
                  <Icon as={FiClock} boxSize={5} color="blue.500" />
                  <VStack align="start" gap={1} flex={1}>
                    <Text fontWeight="medium">Use course time zone</Text>
                    <Text fontSize="sm" color="fg.muted">
                      View all times in {formatTimeZoneName(courseTimeZone)}
                    </Text>
                    <Text fontSize="xs" color="fg.subtle">
                      Recommended for consistency with classmates and instructor
                    </Text>
                  </VStack>
                </HStack>
              </Box>

              {/* Browser timezone option */}
              <Box as="label" display="block" cursor="pointer">
                <HStack
                  p={4}
                  border="1px solid"
                  borderColor="border.muted"
                  borderRadius="md"
                  _hover={{ borderColor: "border.emphasized", bg: "bg.subtle" }}
                  gap={3}
                >
                  <input
                    type="radio"
                    name="timezone-preference"
                    value="browser"
                    checked={mode === "browser"}
                    onChange={(e) => setMode(e.target.value as "course" | "browser")}
                  />
                  <Icon as={FiGlobe} boxSize={5} color="green.500" />
                  <VStack align="start" gap={1} flex={1}>
                    <Text fontWeight="medium">Use your local time zone</Text>
                    <Text fontSize="sm" color="fg.muted">
                      View all times in {formatTimeZoneName(browserTimeZone)}
                    </Text>
                    <Text fontSize="xs" color="fg.subtle">
                      Times will be automatically converted to your local timezone
                    </Text>
                  </VStack>
                </HStack>
              </Box>
            </VStack>

            <Text fontSize="xs" color="fg.subtle" textAlign="center">
              Your choice will be remembered for this course. You can change it later in your settings.
            </Text>
          </VStack>
        </DialogBody>
        <DialogFooter>
          <DialogActionTrigger asChild>
            <Button variant="outline">Close</Button>
          </DialogActionTrigger>
        </DialogFooter>
        <DialogCloseTrigger />
      </DialogContent>
    </DialogRoot>
  );
}
