"use client";

import { Button } from "@/components/ui/button";
import { useIsGraderOrInstructor, useIsStudent } from "@/hooks/useClassProfiles";
import { useCourse } from "@/hooks/useCourseController";
import { courseFeatureEnabled } from "@/lib/courseFeatures";
import type { WhatsNewEntry } from "@/lib/whatsNew/define";
import type { WhatsNewAudience, WhatsNewId, WhatsNewPage } from "@/lib/whatsNew/ids";
import { WHATS_NEW_ENTRIES } from "@/lib/whatsNew/registry";
import type { CourseWithFeatures } from "@/utils/supabase/DatabaseTypes";
import { createClient } from "@/utils/supabase/client";
import { Box, Dialog, HStack, Icon, Stack, Text } from "@chakra-ui/react";
import * as Sentry from "@sentry/nextjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BsClock, BsStars, BsX } from "react-icons/bs";

/**
 * Walkthroughs dismissed since the page loaded. Staff can leave a page and come back before
 * markSeen's upsert commits. The new instance's read then finds no row, so the automatic open also
 * checks this set. It lives at module level so it outlasts a remount.
 */
const dismissedThisPageLoad = new Set<WhatsNewId>();

/** Clears dismissedThisPageLoad. Only tests call it, to start each case from a fresh page load. */
export function resetWhatsNewForTests() {
  dismissedThisPageLoad.clear();
}

/**
 * The ids among `ids` that this user has already seen or dismissed. If the rows can't be read,
 * returns null: an automatic prompt we can't check would otherwise open on every page load.
 */
async function readSeen(ids: WhatsNewId[]): Promise<Set<string> | null> {
  const { data, error } = await createClient().from("user_whats_new_seen").select("item").in("item", ids);
  if (error) {
    Sentry.captureException(error);
    return null;
  }
  return new Set((data ?? []).map((row) => row.item));
}

async function markSeen(id: WhatsNewId) {
  // user_id defaults to auth.uid(), and RLS only accepts the caller's own row.
  const { error } = await createClient()
    .from("user_whats_new_seen")
    .upsert({ item: id }, { onConflict: "user_id,item", ignoreDuplicates: true });
  if (error) Sentry.captureException(error);
}

function audienceMatches(audience: WhatsNewAudience, isStaff: boolean, isStudent: boolean) {
  if (audience === "staff") return isStaff;
  if (audience === "students") return isStudent;
  return isStaff || isStudent;
}

/** Whether `showUntil` (YYYY-MM-DD) is before today in the viewer's time zone. */
function isPast(showUntil: string) {
  return new Date().toLocaleDateString("en-CA") > showUntil;
}

/**
 * Header button plus the walkthrough dialog for one page. It shows the registered walkthroughs
 * (lib/whatsNew/registry.ts) whose page, audience and course feature match the viewer, and renders
 * nothing when none match. The first one this user hasn't seen opens on its own, until its
 * showUntil date, starting with the "want a quick tour?" prompt. Seeing it is recorded per user in
 * public.user_whats_new_seen. The header button opens the newest one.
 */
export function WhatsNew({ page }: { page: WhatsNewPage }) {
  const isStaff = useIsGraderOrInstructor();
  const isStudent = useIsStudent();
  const course = useCourse() as CourseWithFeatures;
  const features = course?.features;

  const entries = useMemo(
    () =>
      WHATS_NEW_ENTRIES.filter(
        (entry) =>
          entry.page === page &&
          audienceMatches(entry.audience, isStaff, isStudent) &&
          (!entry.feature || courseFeatureEnabled(features, entry.feature))
      ),
    [page, isStaff, isStudent, features]
  );
  // A string, so the effect below runs again only when the set of ids changes.
  const autoOpenIds = entries
    .filter((entry) => !isPast(entry.showUntil))
    .map((entry) => entry.id)
    .join(",");

  const [openId, setOpenId] = useState<WhatsNewId | null>(null);
  // -1 is the intro prompt; 0..steps.length-1 are the tutorial steps.
  const [step, setStep] = useState(-1);

  // Set once the user opens or closes the dialog, so a slow read can't reopen it afterwards.
  const handledRef = useRef(false);

  useEffect(() => {
    if (!autoOpenIds) return;
    const ids = autoOpenIds.split(",") as WhatsNewId[];
    let cancelled = false;
    void readSeen(ids).then((seen) => {
      if (cancelled || seen === null || handledRef.current) return;
      const next = ids.find((id) => !seen.has(id) && !dismissedThisPageLoad.has(id));
      if (!next) return;
      setStep(-1);
      setOpenId(next);
    });
    return () => {
      cancelled = true;
    };
  }, [autoOpenIds]);

  const close = useCallback(() => {
    handledRef.current = true;
    if (openId) {
      dismissedThisPageLoad.add(openId);
      void markSeen(openId);
    }
    setOpenId(null);
  }, [openId]);

  const newest = entries[entries.length - 1];
  // The entry the dialog last showed. It stays mounted while it closes, so the close animation
  // still has content to show.
  const shownRef = useRef<WhatsNewEntry | null>(null);
  const reopen = useCallback(() => {
    if (!newest) return;
    handledRef.current = true;
    setStep(-1);
    setOpenId(newest.id);
  }, [newest]);

  if (!newest) return null;

  const entry = entries.find((e) => e.id === openId);
  if (entry) shownRef.current = entry;
  const shown = shownRef.current;

  return (
    <>
      <Button size="xs" variant="outline" colorPalette="purple" onClick={reopen}>
        <Icon as={BsStars} />
        What&apos;s new
      </Button>
      {shown && <WhatsNewDialog entry={shown} open={!!entry} step={step} setStep={setStep} close={close} />}
    </>
  );
}

function WhatsNewDialog({
  entry,
  open,
  step,
  setStep,
  close
}: {
  entry: WhatsNewEntry;
  open: boolean;
  step: number;
  setStep: (update: (s: number) => number) => void;
  close: () => void;
}) {
  const { steps } = entry;
  const isIntro = step < 0;
  const isLast = step === steps.length - 1;
  const current = isIntro ? null : steps[step];

  return (
    <Dialog.Root open={open} onOpenChange={({ open: o }) => !o && close()} size="lg" placement="center">
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>
              {isIntro ? (
                <HStack gap={2}>
                  <Icon as={BsStars} color="purple.fg" />
                  {entry.title}
                </HStack>
              ) : (
                current!.title
              )}
            </Dialog.Title>
            <Dialog.CloseTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="Close tour">
                <Icon as={BsX} />
              </Button>
            </Dialog.CloseTrigger>
          </Dialog.Header>
          <Dialog.Body>
            {isIntro ? (
              <Stack gap={4}>
                {entry.intro}
                <HStack gap={2} color="fg.muted" fontSize="sm">
                  <Icon as={BsClock} />
                  <Text>{steps.length} short steps, about a minute</Text>
                </HStack>
              </Stack>
            ) : (
              current!.body
            )}
          </Dialog.Body>
          <Dialog.Footer>
            {isIntro ? (
              <HStack justify="end" gap={3} w="full">
                <Button variant="outline" onClick={close}>
                  Close
                </Button>
                <Button colorPalette="purple" onClick={() => setStep(() => 0)}>
                  Show me
                </Button>
              </HStack>
            ) : (
              <HStack justify="space-between" w="full">
                <HStack gap={1.5} aria-label={`Step ${step + 1} of ${steps.length}`} role="img">
                  {steps.map((_, i) => (
                    <Box
                      key={i}
                      boxSize={2}
                      borderRadius="full"
                      bg={i === step ? "purple.solid" : i < step ? "purple.muted" : "border.emphasized"}
                    />
                  ))}
                </HStack>
                <HStack gap={3}>
                  <Button variant="outline" onClick={() => setStep((s) => s - 1)} disabled={step === 0}>
                    Back
                  </Button>
                  {isLast ? (
                    <Button colorPalette="purple" onClick={close}>
                      Done
                    </Button>
                  ) : (
                    <Button colorPalette="purple" onClick={() => setStep((s) => s + 1)}>
                      Next
                    </Button>
                  )}
                </HStack>
              </HStack>
            )}
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
