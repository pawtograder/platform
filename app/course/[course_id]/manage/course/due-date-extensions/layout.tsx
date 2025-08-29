"use client";
import { Box, Button, Flex, Heading, HStack, VStack } from "@chakra-ui/react";
import { Select } from "chakra-react-select";
import NextLink from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import React from "react";
import { FaCalendar, FaClock, FaCoins } from "react-icons/fa";

const LinkItems = (courseId: number) => [
  {
    label: "Assignment Exceptions",
    href: `/course/${courseId}/manage/course/due-date-extensions`,
    icon: FaCalendar
  },
  {
    label: "Student Extensions",
    href: `/course/${courseId}/manage/course/due-date-extensions/student-extensions`,
    icon: FaClock
  },
  {
    label: "Roster Tokens",
    href: `/course/${courseId}/manage/course/due-date-extensions/roster-tokens`,
    icon: FaCoins
  }
];

/**
 * Provides a responsive layout for due date extensions management pages, including navigation and content display.
 *
 * Renders due date extension-specific navigation links and content for both desktop and mobile views.
 * Displays navigation for Assignment Exceptions, Student Extensions, and Roster Tokens.
 *
 * @param children - The content to display within the due date extensions layout
 */
export default function DueDateExtensionsLayout({ children }: { children: React.ReactNode }) {
  const { course_id } = useParams();
  const pathname = usePathname();
  const router = useRouter();

  const courseId = Number.parseInt(course_id as string);
  const linkItems = LinkItems(courseId);

  return (
    <>
      <Flex pt={4} display={{ base: "none", lg: "flex" }}>
        <Box w="xs" pr={2} flex={0}>
          <VStack align="flex-start">
            {linkItems.map((item) => (
              <Button
                key={item.label}
                variant={pathname === item.href ? "solid" : "ghost"}
                w="100%"
                size="xs"
                pt="0"
                fontSize="sm"
                justifyContent="flex-start"
                asChild
              >
                <NextLink href={item.href} prefetch={true}>
                  <HStack textAlign="left" w="100%" justify="flex-start">
                    {React.createElement(item.icon)}
                    {item.label}
                  </HStack>
                </NextLink>
              </Button>
            ))}
          </VStack>
        </Box>
        <Box borderColor="border.muted" borderWidth="2px" borderRadius="md" p={4} flexGrow={1} minWidth="0">
          <Heading size="lg">Due Date Exceptions</Heading>
          <Box>{children}</Box>
        </Box>
      </Flex>
      <Flex display={{ base: "flex", lg: "none" }} flexDir={"column"}>
        <Box width="100%" marginTop="5">
          <Heading size="md">Select due date extensions page</Heading>
          <Select
            onChange={(e) => {
              if (e) {
                router.replace(e.value);
              }
            }}
            value={linkItems
              .map((item) => ({ label: item.label, value: item.href }))
              .find((option) => option.value === pathname)}
            options={linkItems.map((item) => ({
              label: item.label,
              value: item.href
            }))}
          />
        </Box>
        <Box mt={4} borderColor="border.muted" borderWidth="2px" borderRadius="md" p={2}>
          <Heading size="lg">Due Date Exceptions</Heading>
          <Box>{children}</Box>
        </Box>
      </Flex>
    </>
  );
}
