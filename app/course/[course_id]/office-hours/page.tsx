"use client";

import { HelpQueue } from "@/utils/supabase/DatabaseTypes";
import { useList } from "@refinedev/core";
import { useParams } from "next/navigation";
import { redirect } from "next/navigation";
import { Box, Card, Container, Heading, Stack, Text, Grid, Badge, Button } from "@chakra-ui/react";
import NextLink from "next/link";
import { BsChatText, BsCameraVideo, BsGeoAlt } from "react-icons/bs";

export default function HelpPage() {
  const { course_id } = useParams();

  const queues = useList<HelpQueue>({
    resource: "help_queues",
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "available", operator: "eq", value: true }
    ]
  });

  if (queues.isLoading) {
    return (
      <Container>
        <Text>Loading help queues...</Text>
      </Container>
    );
  }
  if (queues.error) {
    return (
      <Container>
        <Text color="red.500">Error: {queues.error.message}</Text>
      </Container>
    );
  }

  const availableQueues = queues.data?.data ?? [];

  if (availableQueues.length === 1) {
    redirect(`/course/${course_id}/office-hours/${availableQueues[0].id}`);
    return null;
  }

  const getQueueIcon = (type: string) => {
    switch (type) {
      case "video":
        return <BsCameraVideo />;
      case "in_person":
        return <BsGeoAlt />;
      default:
        return <BsChatText />;
    }
  };

  const getQueueDescription = (type: string) => {
    switch (type) {
      case "video":
        return "Live video chat with TAs";
      case "in_person":
        return "Get help in person";
      case "text":
        return "Text-based help and discussion";
      default:
        return "Get help from TAs and instructors";
    }
  };

  return (
    <Container maxW="4xl" py={8}>
      <Stack spaceY={6}>
        <Box textAlign="center">
          <Heading size="lg" mb={2}>
            Ask for Help
          </Heading>
          <Text color="fg.muted">Choose a help queue to get assistance from course staff</Text>
        </Box>

        {availableQueues.length === 0 ? (
          <Card.Root>
            <Card.Body>
              <Text textAlign="center" color="fg.muted">
                No help queues are currently available.
              </Text>
            </Card.Body>
          </Card.Root>
        ) : (
          <Grid columns={{ base: 1, md: 2 }} gap={4}>
            {availableQueues.map((queue) => (
              <Card.Root key={queue.id} variant="outline" _hover={{ borderColor: "border.emphasized" }}>
                <Card.Body>
                  <Stack spaceY={3}>
                    <Stack direction="row" align="center" justify="space-between">
                      <Stack direction="row" align="center" spaceX={2}>
                        <Box color={queue.color || "fg.default"}>{getQueueIcon(queue.queue_type)}</Box>
                        <Heading size="sm">{queue.name}</Heading>
                      </Stack>
                      <Badge
                        colorPalette={
                          queue.queue_type === "video" ? "green" : queue.queue_type === "in_person" ? "orange" : "blue"
                        }
                      >
                        {queue.queue_type}
                      </Badge>
                    </Stack>

                    <Text fontSize="sm" color="fg.muted">
                      {queue.description || getQueueDescription(queue.queue_type)}
                    </Text>

                    <NextLink href={`/course/${course_id}/office-hours/${queue.id}`} passHref>
                      <Button variant="outline" size="sm" width="full">
                        Join Queue
                      </Button>
                    </NextLink>
                  </Stack>
                </Card.Body>
              </Card.Root>
            ))}
          </Grid>
        )}
      </Stack>
    </Container>
  );
}
