"use client";

import { Box, HStack, Link, Text, Icon } from "@chakra-ui/react";
import { FaExclamationCircle, FaExternalLinkAlt } from "react-icons/fa";
import { useParams } from "next/navigation";
import type { ErrorPinMatch } from "@/hooks/useErrorPinMatches";

interface ErrorPinCalloutProps {
  matches: ErrorPinMatch[];
  /** If true, shows just the links without the wrapper box and header. Useful when embedding in a custom container. */
  linksOnly?: boolean;
}

/**
 * Component that displays error pin matches as a callout near test results.
 * Shows links to relevant discussion threads when a submission matches error pin rules.
 */
export function ErrorPinCallout({ matches, linksOnly = false }: ErrorPinCalloutProps) {
  const { course_id } = useParams();

  if (!matches || matches.length === 0) {
    return null;
  }

  const links = matches.map((match) => (
    <Link
      key={match.error_pin_id}
      href={`/course/${course_id}/discussion/${match.discussion_thread_id}`}
      color="blue.600"
      _dark={{ color: "blue.300" }}
      fontSize="sm"
      display="flex"
      alignItems="center"
      gap={1}
      mb={1}
      _hover={{ textDecoration: "underline" }}
    >
      {match.thread_subject}
      <Icon as={FaExternalLinkAlt} fontSize="xs" />
    </Link>
  ));

  if (linksOnly) {
    return <Box>{links}</Box>;
  }

  return (
    <Box
      mt={2}
      p={3}
      bg="blue.50"
      borderLeft="4px solid"
      borderColor="blue.500"
      borderRadius="md"
      _dark={{ bg: "blue.900" }}
    >
      <HStack gap={2} align="flex-start">
        <Icon as={FaExclamationCircle} color="blue.500" mt={0.5} />
        <Box flex="1">
          <Text fontWeight="semibold" fontSize="sm" mb={1}>
            Looking for troubleshooting help? Check out these related discussion posts that we have auto-matched to the
            errors in this submission:
          </Text>
          {links}
        </Box>
      </HStack>
    </Box>
  );
}
