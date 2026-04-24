"use client";

import { toaster } from "@/components/ui/toaster";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  DialogBody,
  DialogCloseTrigger,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle
} from "@/components/ui/dialog";
import { createClient } from "@/utils/supabase/client";
import { Text } from "@chakra-ui/react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

function parseOriginalRootId(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const fromUrl = trimmed.match(/\/discussion\/(\d+)/);
  if (fromUrl) {
    const n = Number(fromUrl[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

export function MarkDuplicateThreadModal({
  isOpen,
  onClose,
  duplicateRootId,
  onMerged
}: {
  isOpen: boolean;
  onClose: () => void;
  duplicateRootId: number;
  onMerged: (originalRootId: number) => void;
}) {
  const { course_id } = useParams();
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [originalInput, setOriginalInput] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    const originalId = parseOriginalRootId(originalInput);
    if (!originalId) {
      toaster.error({
        title: "Invalid original thread",
        description: "Paste a link to the original post or enter its numeric thread id."
      });
      return;
    }
    if (originalId === duplicateRootId) {
      toaster.error({ title: "Invalid", description: "The original cannot be the same thread." });
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await supabase.rpc("mark_discussion_thread_duplicate", {
        p_duplicate_root_id: duplicateRootId,
        p_original_root_id: originalId
      });
      if (error) throw error;

      toaster.success({
        title: "Merged as duplicate",
        description: "This thread was moved under the original. Students were notified if they authored the duplicate."
      });
      setOriginalInput("");
      onClose();
      onMerged(originalId);
      router.push(`/course/${course_id}/discussion/${originalId}`);
    } catch (e) {
      toaster.error({
        title: "Could not mark duplicate",
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      setSubmitting(false);
    }
  }, [course_id, duplicateRootId, originalInput, onClose, onMerged, router, supabase]);

  return (
    <DialogRoot open={isOpen} onOpenChange={(d) => !d.open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark as duplicate of another thread</DialogTitle>
        </DialogHeader>
        <DialogCloseTrigger />
        <DialogBody>
          <Text fontSize="sm" color="fg.muted" mb="3">
            This post and all of its replies will become replies under the original thread you specify. The author
            receives a notification. A banner will show the former subject and who merged it.
          </Text>
          <Field
            label="Original thread"
            helperText="Paste the URL of the original discussion (e.g. …/course/123/discussion/456) or enter the original thread id."
          >
            <Input
              value={originalInput}
              onChange={(e) => setOriginalInput(e.target.value)}
              placeholder="https://…/course/…/discussion/… or 456"
              disabled={submitting}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} loading={submitting}>
            Merge into original
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
