"use client";

import { Badge, Box, Flex, Text } from "@chakra-ui/react";
import type { QueueHealth, QueueHealthThresholds } from "@/hooks/useQueueHealth";
import { isQueueRed } from "@/lib/queueHealthAlerts";

/** "45 sec", "12 min", "2 hr 5 min". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** Shown in a queue card's header only when the queue has no TA on shift. */
export function QueueUnstaffedBadge({ health }: { health: QueueHealth | undefined }) {
  if (!health) return null;
  return (
    <Badge colorPalette="red" variant="subtle" size="sm">
      {health.unstaffed_seconds !== null
        ? `Unstaffed for ${formatDuration(health.unstaffed_seconds)}`
        : "No TA on shift"}
    </Badge>
  );
}

export type QueueHealthTone = "alert" | "ok";

/**
 * Red when a queue needs action: unstaffed with students waiting, or the oldest wait has reached
 * 30 minutes. Everything else is neutral.
 */
export function queueHealthTone(
  health: QueueHealth | undefined,
  thresholds: QueueHealthThresholds
): QueueHealthTone | undefined {
  if (!health) return undefined;
  // Same red rule as the numbers and the red-queue alert, plus students waiting with nobody on shift.
  if (isQueueRed(health, thresholds) || (health.waiting > 0 && health.staffed_tas === 0)) return "alert";
  return "ok";
}

/** One stat: the number large, its label small underneath. */
function Stat({
  value,
  label,
  color,
  emphasize
}: {
  value: string;
  label: string;
  color?: string;
  emphasize?: boolean;
}) {
  return (
    <Box minW={0}>
      <Text
        fontSize={emphasize ? "xl" : "lg"}
        fontWeight="semibold"
        lineHeight="1.1"
        color={color ?? "fg"}
        fontVariantNumeric="tabular-nums"
      >
        {value}
      </Text>
      <Text fontSize="xs" color="fg.muted">
        {label}
      </Text>
    </Box>
  );
}

/**
 * Live stats for a queue card, in one row: waiting now (the main number) and oldest wait
 * (colored amber, then red, as it ages).
 */
export default function QueueHealthStats({
  health,
  thresholds
}: {
  health: QueueHealth | undefined;
  thresholds: QueueHealthThresholds;
}) {
  if (!health) return null;
  const oldest = health.oldest_wait_seconds;
  const waitingColor = health.waiting >= thresholds.waiting_red ? "red.600" : "fg";
  const oldestColor = health.waiting > 0 && oldest >= thresholds.oldest_wait_red_minutes * 60 ? "red.600" : "fg";
  return (
    <Flex gap={6} align="flex-end" wrap="wrap" aria-label={`${health.queue_name} health`}>
      <Stat value={String(health.waiting)} label="waiting" color={waitingColor} emphasize />
      <Stat value={health.waiting > 0 ? formatDuration(oldest) : "—"} label="oldest wait" color={oldestColor} />
    </Flex>
  );
}
