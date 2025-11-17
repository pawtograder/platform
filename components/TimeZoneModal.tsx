"use client";

import { useTimeZone } from "@/lib/TimeZoneProvider";
import { TimeZoneSelector } from "./TimeZoneSelector";
import {
  DialogRoot,
  DialogBackdrop,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  DialogCloseTrigger
} from "@chakra-ui/react";
import { Button } from "@/components/ui/button";

export function TimeZoneModal() {
  const { showModal, dismissModal } = useTimeZone();

  if (!showModal) {
    return null;
  }

  return (
    <DialogRoot open={showModal} onOpenChange={() => dismissModal()} size="md">
      <DialogBackdrop />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Time Zone Settings</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <TimeZoneSelector />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={dismissModal}>
            Close
          </Button>
        </DialogFooter>
        <DialogCloseTrigger />
      </DialogContent>
    </DialogRoot>
  );
}
