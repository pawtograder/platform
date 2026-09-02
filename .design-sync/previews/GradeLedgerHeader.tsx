import { GradeLedgerHeader } from "@pawtograder/webapp";

export const ReleasedFullBreakdown = () => (
  <GradeLedgerHeader
    assignmentTitle="Assignment 4 — Hash Maps & Open Addressing"
    submissionOrdinal={7}
    submittedAt="2026-03-14T18:42:00Z"
    released={true}
    total={88}
    totalPossible={100}
    autoEarned={60}
    autoMax={60}
    handContribution={33}
    tweak={-5}
    hasAutograder={true}
    hasHandGrading={true}
  />
);

export const AutograderOnly = () => (
  <GradeLedgerHeader
    assignmentTitle="Lab 6 — Iterators"
    submissionOrdinal={3}
    submittedAt="2026-03-09T14:05:00Z"
    released={true}
    total={45}
    totalPossible={50}
    autoEarned={45}
    autoMax={50}
    handContribution={null}
    tweak={0}
    hasAutograder={true}
    hasHandGrading={false}
  />
);

export const NotReleased = () => (
  <GradeLedgerHeader
    assignmentTitle="Final Project — Concurrent Cache"
    submissionOrdinal={2}
    submittedAt="2026-04-18T23:11:00Z"
    released={false}
    total={null}
    totalPossible={120}
    autoEarned={72}
    autoMax={80}
    handContribution={null}
    tweak={0}
    hasAutograder={true}
    hasHandGrading={true}
  />
);

export const CappedOverMax = () => (
  <GradeLedgerHeader
    assignmentTitle="Assignment 2 — Recursion (with extra credit)"
    submissionOrdinal={5}
    submittedAt="2026-02-12T09:30:00Z"
    released={true}
    total={104}
    totalPossible={100}
    autoEarned={100}
    autoMax={100}
    handContribution={0}
    tweak={4}
    hasAutograder={true}
    hasHandGrading={true}
  />
);
