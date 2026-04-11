"use client";

import { Box, Card, HStack, Icon, Stack, Text, VStack } from "@chakra-ui/react";
import { BsExclamationTriangle } from "react-icons/bs";
import type { Alert } from "@/types/survey-analytics";

type AlertWithGroup = Alert & { groupName?: string };

type AlertsPanelProps = {
  alerts: AlertWithGroup[];
};

export function AlertsPanel({ alerts }: AlertsPanelProps) {
  const criticalAlerts = alerts.filter((a) => a.severity === "critical");
  const warningAlerts = alerts.filter((a) => a.severity === "warning");
  const infoAlerts = alerts.filter((a) => a.severity === "info");

  const groupedAlerts = [...criticalAlerts, ...warningAlerts, ...infoAlerts];

  if (groupedAlerts.length === 0) {
    return null;
  }

  return (
    <Card.Root borderColor="orange.500" borderWidth="1px">
      <Card.Header>
        <HStack gap={2}>
          <Icon as={BsExclamationTriangle} color="orange.500" />
          <Text fontSize="lg" fontWeight="semibold" color="orange.600">
            Groups Needing Attention
          </Text>
        </HStack>
      </Card.Header>
      <Card.Body>
        <Stack spaceY={2}>
          {groupedAlerts.map((alert, idx) => (
            <Box key={idx} p={3} bg="bg.warning" borderRadius="md" borderWidth="1px" borderColor="border.warning">
              <VStack align="stretch" gap={1}>
                {alert.groupName && (
                  <Text fontSize="sm" fontWeight="semibold" color="fg">
                    {alert.groupName}
                  </Text>
                )}
                <Text fontSize="sm">{alert.message}</Text>
                {alert.questionName && (
                  <Text fontSize="xs" color="fg.muted">
                    Question: {alert.questionName}
                  </Text>
                )}
              </VStack>
            </Box>
          ))}
        </Stack>
        <Text fontSize="sm" color="fg.muted" mt={3}>
          Consider reaching out to these teams to offer support.
        </Text>
      </Card.Body>
    </Card.Root>
  );
}
