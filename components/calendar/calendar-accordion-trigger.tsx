"use client";

import { Accordion, Heading, HStack, Icon } from "@chakra-ui/react";
import { BsCalendar, BsChevronDown } from "react-icons/bs";

export function CalendarAccordionTrigger() {
  return (
    <Accordion.ItemTrigger>
      <HStack gap={2} justifyContent="space-between" w="100%">
        <HStack gap={2}>
          <Icon as={BsCalendar} color="blue.500" />
          <Heading size="sm">Schedule</Heading>
        </HStack>
        <Accordion.ItemIndicator>
          <Icon as={BsChevronDown} />
        </Accordion.ItemIndicator>
      </HStack>
    </Accordion.ItemTrigger>
  );
}
