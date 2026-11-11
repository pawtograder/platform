"use client";

import { Button } from "@/components/ui/button";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { ESCALATION_NOTE_MAX_LENGTH } from "@/lib/helpRequestEscalation";
import { Badge, Box, Dialog, HStack, Icon, Stack, Table, Text } from "@chakra-ui/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { BsArrowUpCircle, BsCheck, BsCheckCircle, BsClock, BsStars, BsX, BsXCircle, BsXOctagon } from "react-icons/bs";
import { EscalationBadge } from "./escalation-badge";

/**
 * "What's new" walkthrough of ticket escalation for course staff. It opens once per browser on the
 * staff Office Hours pages, and the header button reopens it. Every step is a static preview of the
 * real controls (same colors, icons and labels as help-request-chat.tsx), so it works whatever state
 * the queue is in.
 */

const SEEN_KEY = "pawtograder:whats-new:oh-escalation:v1";

function hasSeenTour(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === "seen";
  } catch {
    // Storage blocked (private window, site data disabled): treat as seen so the popup
    // doesn't reappear on every page load. The header button still opens it.
    return true;
  }
}

function markTourSeen() {
  try {
    window.localStorage.setItem(SEEN_KEY, "seen");
  } catch {
    // Nothing to do: see hasSeenTour.
  }
}

/** Non-interactive frame around a preview of the real UI. */
function Preview({ children }: { children: ReactNode }) {
  return (
    <Box
      aria-hidden
      pointerEvents="none"
      userSelect="none"
      borderWidth="1px"
      borderColor="border.muted"
      borderStyle="dashed"
      borderRadius="md"
      bg="bg.subtle"
      p={4}
    >
      {children}
    </Box>
  );
}

function Points({ items }: { items: ReactNode[] }) {
  return (
    <Stack as="ul" gap={2} ps={5} listStyleType="disc" fontSize="sm">
      {items.map((item, i) => (
        <Box as="li" key={i}>
          {item}
        </Box>
      ))}
    </Stack>
  );
}

const EscalateButton = () => (
  <Button size="xs" colorPalette="purple">
    <Icon as={BsArrowUpCircle} />
    Escalate
  </Button>
);
const ResolveButton = () => (
  <Button size="xs" colorPalette="blue" variant="outline">
    <Icon as={BsCheck} />
    Resolve
  </Button>
);
const EndTicketButton = () => (
  <Button size="xs" colorPalette="red" variant="solid">
    <Icon as={BsXOctagon} />
    End ticket
  </Button>
);

type Step = { title: string; body: ReactNode };

const STEPS: Step[] = [
  {
    title: "Escalate: hand a ticket on",
    body: (
      <Stack gap={4}>
        <Preview>
          <Stack gap={3}>
            <HStack gap={2}>
              <EscalateButton />
              <ResolveButton />
              <EndTicketButton />
            </HStack>
            <Box borderWidth="1px" borderColor="border" borderRadius="sm" bg="bg.panel" p={2}>
              <Text fontSize="xs" fontWeight="medium" mb={1}>
                What&apos;s still unresolved?
              </Text>
              <Text fontSize="xs" color="fg.muted">
                Tried memoizing the recursion, still hitting a stack overflow on the big test.
              </Text>
            </Box>
          </Stack>
        </Preview>
        <Points
          items={[
            <>
              While you&apos;re helping a student, the purple <b>Escalate</b> button appears next to Resolve. Only the
              TA currently helping sees it.
            </>,
            <>
              You write a short note on what you tried and what&apos;s still broken (up to {ESCALATION_NOTE_MAX_LENGTH}{" "}
              characters). Only course staff can read it.
            </>,
            <>
              The ticket goes back to the queue, unassigned, and sorts <b>above every normal ticket</b>, so the student
              doesn&apos;t start over at the back of the line.
            </>
          ]}
        />
      </Stack>
    )
  },
  {
    title: "What an escalated ticket looks like",
    body: (
      <Stack gap={4}>
        <Preview>
          <Stack gap={2}>
            <Box borderWidth="1px" borderColor="purple.muted" borderRadius="sm" bg="bg.panel" p={2}>
              <HStack gap={2} mb={1}>
                <Text fontSize="sm" fontWeight="semibold">
                  Recursion help, HW 4
                </Text>
                <EscalationBadge escalationCount={2} size="xs" />
              </HStack>
              <Text fontSize="sm" color="purple.fg" truncate>
                Still unresolved: stack overflow on the big test, memoization didn&apos;t fix it
              </Text>
            </Box>
            <Box borderWidth="1px" borderColor="border.muted" borderRadius="sm" bg="bg.panel" p={2} opacity={0.7}>
              <Text fontSize="sm">Question about lab 3 setup</Text>
            </Box>
          </Stack>
        </Preview>
        <Points
          items={[
            <>
              The purple <EscalationBadge escalationCount={1} size="xs" /> badge marks it. After a second escalation it
              reads <b>Escalated ×2</b>.
            </>,
            <>
              It sits at the top of the queue, and every staff member working the queue can claim it. The queue row
              previews the latest note.
            </>,
            <>
              When you open it, a history panel shows <b>who already helped</b>, <b>how long the student has waited</b>,
              and <b>every escalation note</b>, so the student doesn&apos;t have to explain again.
            </>
          ]}
        />
      </Stack>
    )
  },
  {
    title: "Resolve now checks in with the student",
    body: (
      <Stack gap={4}>
        <Preview>
          <Stack gap={3} align="center">
            <Text fontSize="sm" fontWeight="semibold">
              Did your problem get fixed?
            </Text>
            <HStack gap={4}>
              <Button size="sm" variant="outline" colorPalette="gray" flexDirection="column" height="auto" py={3}>
                <Icon as={BsCheckCircle} fontSize="lg" />
                <Text fontSize="xs">Yes, I&apos;m done</Text>
              </Button>
              <Button size="sm" variant="outline" colorPalette="gray" flexDirection="column" height="auto" py={3}>
                <Icon as={BsXCircle} fontSize="lg" />
                <Text fontSize="xs">No, still stuck</Text>
              </Button>
            </HStack>
            <Text fontSize="xs" color="fg.muted">
              What the student sees on any course page after you press Resolve
            </Text>
          </Stack>
        </Preview>
        <Points
          items={[
            <>
              <ResolveButtonInline /> is <b>no longer final</b>. The student gets <b>10 minutes</b> to answer &quot;Did
              your problem get fixed?&quot;.
            </>,
            <>
              <b>Yes:</b> the ticket stays resolved, and the student gets the usual feedback prompt.
            </>,
            <>
              <b>No:</b> the student writes what they&apos;re still stuck on, and the ticket is escalated automatically.
              This is how students escalate. They don&apos;t have an Escalate button.
            </>,
            <>
              <b>No answer within 10 minutes:</b> the ticket stays resolved.
            </>
          ]}
        />
      </Stack>
    )
  },
  {
    title: "End ticket: done for good",
    body: (
      <Stack gap={4}>
        <Preview>
          <HStack gap={2}>
            <ResolveButton />
            <EndTicketButton />
          </HStack>
        </Preview>
        <Points
          items={[
            <>
              The red <b>End ticket</b> button closes the ticket permanently. There&apos;s <b>no check-in</b>, nobody
              can escalate it again, and the student can&apos;t reopen it.
            </>,
            <>
              Use it when more help won&apos;t fix the problem, like the wrong queue, a question for the instructor
              outside office hours, or a student who already left.
            </>,
            <>You can also end a ticket you already resolved, during its check-in, to withdraw the check-in.</>,
            <>End the video call first: neither Resolve nor End ticket works mid-call.</>
          ]}
        />
      </Stack>
    )
  },
  {
    title: "Resolve vs End ticket",
    body: (
      <Stack gap={4}>
        <Table.Root size="sm" variant="outline">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader />
              <Table.ColumnHeader>
                <ResolveButtonInline />
              </Table.ColumnHeader>
              <Table.ColumnHeader>
                <Badge colorPalette="red" variant="solid">
                  <Icon as={BsXOctagon} />
                  End ticket
                </Badge>
              </Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            <Table.Row>
              <Table.Cell fontWeight="medium">Student check-in</Table.Cell>
              <Table.Cell>Yes, for 10 minutes</Table.Cell>
              <Table.Cell>No</Table.Cell>
            </Table.Row>
            <Table.Row>
              <Table.Cell fontWeight="medium">Can be escalated afterwards</Table.Cell>
              <Table.Cell>Yes, if the student says No</Table.Cell>
              <Table.Cell>Never</Table.Cell>
            </Table.Row>
            <Table.Row>
              <Table.Cell fontWeight="medium">Use when</Table.Cell>
              <Table.Cell>You think it&apos;s fixed</Table.Cell>
              <Table.Cell>It&apos;s done, whether or not it&apos;s fixed</Table.Cell>
            </Table.Row>
          </Table.Body>
        </Table.Root>
        <Text fontSize="sm" color="fg.muted">
          Can&apos;t finish it yourself but the student still needs help? Use <b>Escalate</b> instead.
        </Text>
      </Stack>
    )
  }
];

function ResolveButtonInline() {
  return (
    <Badge colorPalette="blue" variant="outline">
      <Icon as={BsCheck} />
      Resolve
    </Badge>
  );
}

/**
 * Header button plus the walkthrough dialog. Renders nothing for students. Opens on its own the
 * first time a staff member visits (per browser), starting with the "want to learn more?" prompt.
 */
export function EscalationTour() {
  const isStaff = useIsGraderOrInstructor();
  const [open, setOpen] = useState(false);
  // -1 is the intro prompt; 0..STEPS.length-1 are the tutorial steps.
  const [step, setStep] = useState(-1);

  useEffect(() => {
    if (isStaff && !hasSeenTour()) {
      setStep(-1);
      setOpen(true);
    }
  }, [isStaff]);

  const close = useCallback(() => {
    markTourSeen();
    setOpen(false);
  }, []);

  const reopen = useCallback(() => {
    setStep(-1);
    setOpen(true);
  }, []);

  if (!isStaff) return null;

  const isIntro = step < 0;
  const isLast = step === STEPS.length - 1;
  const current = isIntro ? null : STEPS[step];

  return (
    <>
      <Button size="xs" variant="outline" colorPalette="purple" onClick={reopen}>
        <Icon as={BsStars} />
        What&apos;s new
      </Button>
      <Dialog.Root open={open} onOpenChange={({ open: o }) => !o && close()} size="lg" placement="center">
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>
                {isIntro ? (
                  <HStack gap={2}>
                    <Icon as={BsStars} color="purple.fg" />
                    New in Office Hours: ticket escalation
                  </HStack>
                ) : (
                  current!.title
                )}
              </Dialog.Title>
              <Dialog.CloseTrigger asChild>
                <Button variant="ghost" size="sm" aria-label="Close">
                  <Icon as={BsX} />
                </Button>
              </Dialog.CloseTrigger>
            </Dialog.Header>
            <Dialog.Body>
              {isIntro ? (
                <Stack gap={4}>
                  <Text>
                    When you can&apos;t finish a student&apos;s question, you can now hand it to another staff member
                    with a note on what you tried. The student keeps their place instead of rejoining at the back of the
                    line.
                  </Text>
                  <Text>
                    Resolve also works differently now, and there&apos;s a new <b>End ticket</b> button. Want a quick
                    tour?
                  </Text>
                  <HStack gap={2} color="fg.muted" fontSize="sm">
                    <Icon as={BsClock} />
                    <Text>{STEPS.length} short steps, about a minute</Text>
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
                  <Button colorPalette="purple" onClick={() => setStep(0)}>
                    Show me
                  </Button>
                </HStack>
              ) : (
                <HStack justify="space-between" w="full">
                  <HStack gap={1.5} aria-label={`Step ${step + 1} of ${STEPS.length}`} role="img">
                    {STEPS.map((_, i) => (
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
    </>
  );
}
