"use client";

import { EscalationBadge } from "@/components/help-queue/escalation-badge";
import { Button } from "@/components/ui/button";
import { ESCALATION_NOTE_MAX_LENGTH } from "@/lib/helpRequestEscalation";
import { Badge, Box, HStack, Icon, Stack, Table, Text } from "@chakra-ui/react";
import { BsArrowUpCircle, BsCheck, BsCheckCircle, BsXCircle, BsXOctagon } from "react-icons/bs";
import { defineWhatsNew, Points, Preview, type WhatsNewStep } from "../define";
import { WHATS_NEW_IDS } from "../ids";

/*
 * Ticket escalation in Office Hours (#1169), for course staff. Every step is a static preview of
 * the real controls (same colors, icons and labels as help-request-chat.tsx), so it works whatever
 * state the queue is in.
 */

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

function ResolveButtonInline() {
  return (
    <Badge colorPalette="blue" variant="outline">
      <Icon as={BsCheck} />
      Resolve
    </Badge>
  );
}

const STEPS: WhatsNewStep[] = [
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
              Use it when more help won&apos;t fix the problem, such as the wrong queue, a question for the instructor
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

export default defineWhatsNew({
  id: WHATS_NEW_IDS.OH_ESCALATION,
  page: "office-hours",
  audience: "staff",
  showUntil: "2027-01-21",
  title: "New in Office Hours: ticket escalation",
  intro: (
    <>
      <Text>
        When you can&apos;t finish a student&apos;s question, you can now hand it to another staff member with a note on
        what you tried. The student keeps their place instead of rejoining at the back of the line.
      </Text>
      <Text>
        Resolve also works differently now, and there&apos;s a new <b>End ticket</b> button. Want a quick tour?
      </Text>
    </>
  ),
  steps: STEPS
});
