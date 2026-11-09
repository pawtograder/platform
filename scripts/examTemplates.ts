/**
 * Exam and quiz scenarios for the database seeder (see ExamSeeding.ts).
 *
 * Each scenario becomes one assignment of type `exam` or `quiz`. Together they cover the
 * shapes the exam feature supports:
 *   - question trees that are flat, two levels deep, three levels deep, and mixed
 *     (a level-1 leaf next to a level-1 part with children)
 *   - every answer type: multiple_choice (single and multi-select), true_false, numeric
 *     (exact and with a tolerance), short_answer, and free_text
 *   - template sources: a PDF generated from the questions, an uploaded PDF with regions
 *     drawn by hand, and an uploaded PDF that has no structure yet
 *   - exams from one page to five, including a prompt that runs across a page break and a
 *     question whose answer box continues onto the next page (two answer regions)
 *   - paper delivery with scan batches in each state staff can see (uploaded, review,
 *     completed, error), and in-app delivery with autograded attempts and retakes
 *   - grading that is finished and released, finished but held back, and still in progress
 *
 * Student answers are drawn from `responses` (free text and short answer, best first, each
 * with the fraction of the question's points it earns) or from `distractors` (wrong
 * numeric answers). Objective questions use `correct_answer` for the right answer and the
 * other `choices` for wrong ones.
 */

export type SeedAnswerType = "multiple_choice" | "true_false" | "numeric" | "short_answer" | "free_text";

export type SeedExamQuestion = {
  /** Unique within the scenario; becomes the question's client_id. */
  key: string;
  /** Key of the parent question. Omitted for level-1 questions. */
  parent?: string;
  label: string;
  prompt?: string;
  answer_type?: SeedAnswerType;
  choices?: string[];
  points?: number;
  correct_answer?: { choice: string } | { choices: string[] } | { value: boolean } | { value: number };
  grading_tolerance?: number;
  /** short_answer / free_text: sample answers, best first, with the fraction of points each earns. */
  responses?: { text: string; credit: number }[];
  /** numeric: plausible wrong answers. */
  distractors?: number[];
  /**
   * The answer box continues on a page of its own right after the page the box is on, so
   * the question has two answer regions. Only for instructor-supplied PDF templates: the
   * builder's generated PDF cannot express it, and that PDF is stored for printing.
   */
  answerContinues?: boolean;
};

export type SeedScanBatch = {
  /**
   * completed: every paper is matched, finalized into a submission, and graded per `grading`.
   * review:    papers are OCR'd and matched, waiting for staff to confirm the matches.
   * uploaded:  pages are stored but processing has not been started.
   * error:     an upload that failed part-way; only some pages were stored.
   */
  status: "completed" | "review" | "uploaded" | "error";
  /** Fraction of the scanned students whose papers are in this batch. */
  fraction: number;
};

export type SeedExamScenario = {
  key: string;
  title: string;
  slug: string;
  assignmentType: "exam" | "quiz";
  delivery: "paper" | "in_app";
  /**
   * generated: the PDF is generated from the questions, so every region is exact (builder flow).
   * pdf:       an instructor-supplied PDF; regions are drawn by hand, so they are a little loose.
   * pdf-only:  an instructor-supplied PDF with no questions or regions defined yet.
   */
  template: "generated" | "pdf" | "pdf-only";
  /** Days relative to the seed date. */
  releaseOffsetDays: number;
  dueOffsetDays: number;
  questions: SeedExamQuestion[];
  /** Paper exams: the scan batches to create, oldest first. */
  batches?: SeedScanBatch[];
  /** In-app quizzes: who submits, and who submits a second attempt. */
  attempts?: { submitRate: number; retakeRate: number };
  /** How far grading has progressed on the submissions this scenario creates. */
  grading?: { completedFraction: number; release: boolean };
};

const mc = (key: string, label: string, choices: string[], answer: string, points: number, parent?: string) =>
  ({
    key,
    parent,
    label,
    answer_type: "multiple_choice",
    choices,
    correct_answer: { choice: answer },
    points
  }) satisfies SeedExamQuestion;

const tf = (key: string, label: string, answer: boolean, points: number, parent?: string) =>
  ({
    key,
    parent,
    label,
    answer_type: "true_false",
    correct_answer: { value: answer },
    points
  }) satisfies SeedExamQuestion;

export const EXAM_SCENARIOS: SeedExamScenario[] = [
  {
    // Three-level paper exam, scanned, finalized, graded, and released.
    key: "midterm-1",
    title: "Midterm Exam 1",
    slug: "midterm-1",
    assignmentType: "exam",
    delivery: "paper",
    template: "generated",
    releaseOffsetDays: -42,
    dueOffsetDays: -35,
    batches: [{ status: "completed", fraction: 1 }],
    grading: { completedFraction: 0.85, release: true },
    questions: [
      { key: "A", label: "Part A: Types and Equality" },
      { key: "A1", parent: "A", label: "Question 1", prompt: "Answer each part about Java's type system." },
      mc(
        "A1a",
        "1(a) Which type stores a 64-bit signed integer?",
        ["int", "long", "double", "Integer"],
        "long",
        2,
        "A1"
      ),
      tf("A1b", "1(b) True or false: a String in Java is mutable.", false, 2, "A1"),
      {
        key: "A1c",
        parent: "A1",
        label: "1(c) What does the expression 17 / 5 evaluate to in Java?",
        answer_type: "numeric",
        correct_answer: { value: 3 },
        distractors: [3.4, 4, 2],
        points: 2
      },
      { key: "A2", parent: "A", label: "Question 2", prompt: "Short answers about object equality." },
      {
        key: "A2a",
        parent: "A2",
        label: "2(a) Which method do you override to define logical equality?",
        answer_type: "short_answer",
        points: 3,
        responses: [
          { text: "equals(Object o)", credit: 1 },
          { text: "equals", credit: 1 },
          { text: "hashCode", credit: 0 },
          { text: "compareTo", credit: 0 }
        ]
      },
      {
        key: "A2b",
        parent: "A2",
        label: "2(b) Why must you override hashCode whenever you override equals?",
        answer_type: "free_text",
        points: 5,
        responses: [
          {
            text: "Hash-based collections find the bucket with hashCode and only then call equals. Two equal objects with different hash codes land in different buckets, so a HashSet can hold both and contains() can miss one.",
            credit: 1
          },
          {
            text: "Equal objects have to return the same hash code, otherwise HashMap and HashSet do not work right.",
            credit: 0.6
          },
          { text: "Because Java requires both methods to be overridden together or it will not compile.", credit: 0.2 },
          { text: "So the objects print the same.", credit: 0 }
        ]
      },
      { key: "B", label: "Part B: Design" },
      {
        key: "B3",
        parent: "B",
        label: "Question 3",
        prompt:
          "Design an interface Shape with area() and perimeter(). Describe one benefit of writing client code against the interface rather than a concrete class.",
        answer_type: "free_text",
        points: 10,
        responses: [
          {
            text: "interface Shape { double area(); double perimeter(); } Client code that takes a Shape works for Circle, Square, and any shape added later without changing, so the client is open for extension and can be tested with a fake Shape.",
            credit: 1
          },
          {
            text: "interface Shape { double area(); double perimeter(); } It lets you swap implementations, which is polymorphism.",
            credit: 0.7
          },
          { text: "abstract class Shape with area and perimeter methods. It saves typing.", credit: 0.3 },
          { text: "Shape has area and perimeter.", credit: 0.1 }
        ]
      },
      { key: "B4", parent: "B", label: "Question 4", prompt: "Consider the naive recursive Fibonacci method fib(n)." },
      {
        key: "B4a",
        parent: "B4",
        label: "4(a) How many calls to fib are made in total when computing fib(4)?",
        answer_type: "numeric",
        correct_answer: { value: 9 },
        distractors: [5, 8, 4],
        points: 3
      },
      {
        key: "B4b",
        parent: "B4",
        label: "4(b) Describe how to compute fib(n) in linear time.",
        answer_type: "free_text",
        points: 6,
        responses: [
          {
            text: "Iterate from 2 to n keeping only the previous two values, or memoize fib in an array so each value is computed once. Either way there are n steps.",
            credit: 1
          },
          { text: "Use memoization so you do not recompute values.", credit: 0.7 },
          { text: "Use a loop instead of recursion.", credit: 0.4 },
          { text: "Recursion is always linear.", credit: 0 }
        ]
      },
      {
        // A level-1 leaf beside parts that have children (a mixed tree).
        key: "C",
        label: "Part C: Reflection",
        prompt: "Describe a bug you found this semester and a test that would have caught it earlier.",
        answer_type: "free_text",
        points: 4,
        responses: [
          {
            text: "My linked list remove() skipped the node after the one it removed. A test removing two adjacent elements and checking size and order would have failed right away.",
            credit: 1
          },
          { text: "An off-by-one in a loop. A unit test for the empty list would catch it.", credit: 0.75 },
          { text: "I had a NullPointerException. More tests.", credit: 0.25 }
        ]
      }
    ]
  },
  {
    // A five-page exam on an instructor-supplied PDF. Problem 2's scenario is long enough to
    // run across a page break, and Problem 3's answer box continues onto a page of its own,
    // so one question has answer regions on two pages. Graded, not yet released.
    key: "midterm-3",
    title: "Midterm Exam 3",
    slug: "midterm-3",
    assignmentType: "exam",
    delivery: "paper",
    template: "pdf",
    releaseOffsetDays: -20,
    dueOffsetDays: -18,
    batches: [{ status: "completed", fraction: 1 }],
    grading: { completedFraction: 0.7, release: false },
    questions: [
      { key: "M1", label: "Problem 1: Concurrency Basics" },
      mc(
        "M1a",
        "1(a) Which of these guarantees that a write by one thread is visible to another?",
        ["A local variable", "A volatile field", "A final local", "A static method"],
        "A volatile field",
        2,
        "M1"
      ),
      tf("M1b", "1(b) True or false: two threads calling ArrayList.add at the same time is safe.", false, 2, "M1"),
      {
        key: "M1c",
        parent: "M1",
        label: "1(c) Describe a deadlock and one way to prevent it.",
        answer_type: "free_text",
        points: 6,
        responses: [
          {
            text: "Two threads each hold a lock the other needs, so both wait forever. Always acquiring locks in the same global order prevents the cycle.",
            credit: 1
          },
          { text: "When threads wait on each other forever. Use fewer locks.", credit: 0.5 },
          { text: "When the program is slow because of threads.", credit: 0 }
        ]
      },
      {
        key: "M1d",
        parent: "M1",
        label: "1(d) Why is calling Thread.sleep inside a synchronized block usually a mistake?",
        answer_type: "free_text",
        points: 4,
        responses: [
          {
            text: "sleep keeps the monitor, so every other thread that needs the lock is blocked for the whole sleep even though no work is being done.",
            credit: 1
          },
          { text: "It makes the other threads wait.", credit: 0.5 },
          { text: "sleep is deprecated.", credit: 0 }
        ]
      },
      {
        key: "M1e",
        parent: "M1",
        label: "1(e) Name the java.util.concurrent class for a thread-safe counter.",
        answer_type: "short_answer",
        points: 2,
        responses: [
          { text: "AtomicInteger", credit: 1 },
          { text: "AtomicLong", credit: 1 },
          { text: "Integer", credit: 0 },
          { text: "ConcurrentHashMap", credit: 0 }
        ]
      },
      {
        key: "M2",
        label: "Problem 2: Designing a Ticket Booking Service",
        prompt:
          "A regional theater sells tickets online. Each performance has a seating chart of up to 900 seats, " +
          "split into sections with different prices. Customers browse the chart, pick seats, and have ten " +
          "minutes to pay before the seats are released to other customers. Box-office staff sell tickets " +
          "in person through the same system, and the theater's accountant runs a nightly report of sales " +
          "per performance and per section. During popular on-sale events several thousand customers " +
          "arrive within the first minute, and the current system has sold the same seat to two customers " +
          "more than once. The theater also wants to add a waitlist: when a held seat is released, the " +
          "first customer on the waitlist for that section is offered it before anyone else can see it. " +
          "Payments are processed by an external provider that can take up to thirty seconds to respond " +
          "and occasionally times out without saying whether the charge went through. Management has asked " +
          "you to redesign the booking service so that no seat is ever sold twice, holds expire reliably, " +
          "the waitlist is fair, and a slow or failed payment never leaves a seat stuck in limbo. Read the " +
          "whole scenario before answering the parts below; each part builds on the one before."
      },
      {
        key: "M2a",
        parent: "M2",
        label: "2(a) Name the shared resource that must be protected from concurrent updates.",
        answer_type: "short_answer",
        points: 3,
        responses: [
          { text: "The seat's status (available, held, sold)", credit: 1 },
          { text: "The seats", credit: 0.7 },
          { text: "The database", credit: 0.3 },
          { text: "The payment provider", credit: 0 }
        ]
      },
      {
        key: "M2b",
        parent: "M2",
        label: "2(b) How would you make sure a held seat is released when its ten minutes run out?",
        answer_type: "free_text",
        points: 6,
        responses: [
          {
            text: "Store an expiry time on each hold and treat expired holds as available in every query, then have a scheduled job clear them and notify the waitlist. Nothing depends on a timer in one server's memory.",
            credit: 1
          },
          { text: "Start a timer for each hold that releases the seat after ten minutes.", credit: 0.5 },
          { text: "The customer releases it when they leave.", credit: 0 }
        ]
      },
      {
        key: "M3",
        label: "Problem 3: Code Review",
        prompt:
          "Review the reserveSeat method from the handout. Identify every problem you can find with its " +
          "correctness under concurrency, its handling of payment timeouts, and its design, and explain " +
          "how you would fix each one. Use the continuation page if you need more room.",
        answer_type: "free_text",
        points: 15,
        answerContinues: true,
        responses: [
          {
            text:
              "First, reserveSeat checks seat.isAvailable() and then calls seat.hold() as two separate steps, so two " +
              "requests can both see the seat as available and both hold it. The check and the update have to be one " +
              "atomic operation, for example a conditional update in the database (update seats set status = held " +
              "where id = ? and status = available) whose row count tells you whether you won. Second, the method " +
              "calls the payment provider while holding the lock on the performance, so every other customer waits " +
              "up to thirty seconds; the payment call has to happen outside any lock. Third, a timeout from the " +
              "provider is treated as a failure and the seat is released, but the charge may have gone through. The " +
              "booking should record a pending state with an idempotency key and ask the provider for the result " +
              "before releasing anything. Fourth, the hold expiry lives in a Timer inside the server, so a restart " +
              "loses every hold; store the expiry time with the hold instead. Finally the method mixes seat rules, " +
              "payment, and email in one place, which is why none of it is tested. I would split it into a " +
              "SeatInventory, a PaymentGateway interface, and a BookingService that coordinates them, so each piece " +
              "can be tested with fakes.",
            credit: 1
          },
          {
            text:
              "There is a race condition because the method checks if the seat is available and then holds it in a " +
              "separate step, so two customers can get the same seat. It should use a lock or a database transaction " +
              "around both steps. Also it calls the payment provider inside the synchronized block, which makes " +
              "everyone wait for the slow provider. Move the payment call out of the lock. When the payment times " +
              "out the code releases the seat, but the customer might have been charged, so it should check with " +
              "the provider first.",
            credit: 0.65
          },
          {
            text: "There is a race condition between checking and holding the seat. Add synchronized to the method.",
            credit: 0.3
          },
          { text: "The method is too long and should be split up.", credit: 0.1 }
        ]
      },
      { key: "M5", label: "Problem 4: Testing the Booking Service" },
      {
        key: "M5a",
        parent: "M5",
        label: "4(a) Describe a test that would have caught the double-sold seat.",
        answer_type: "free_text",
        points: 5,
        responses: [
          {
            text: "Start many threads that all try to reserve the same seat at once, wait for them, and assert that exactly one reservation succeeded and the seat is sold once.",
            credit: 1
          },
          { text: "Have two users book the same seat and check one fails.", credit: 0.6 },
          { text: "Test that booking a seat works.", credit: 0.1 }
        ]
      },
      {
        key: "M5b",
        parent: "M5",
        label: "4(b) How would you test the payment timeout without waiting thirty seconds?",
        answer_type: "free_text",
        points: 5,
        responses: [
          {
            text: "Put the provider behind a PaymentGateway interface and use a fake that throws a timeout immediately, with an injected clock, then assert the booking stays pending.",
            credit: 1
          },
          { text: "Mock the payment provider so it times out.", credit: 0.7 },
          { text: "Set the timeout lower.", credit: 0.3 }
        ]
      },
      {
        key: "M5c",
        parent: "M5",
        label: "4(c) Why are tests that use real timers often flaky?",
        answer_type: "free_text",
        points: 4,
        responses: [
          {
            text: "They depend on how fast the machine is. A slow CI runner misses a deadline the test assumes, so the same code passes and fails.",
            credit: 1
          },
          { text: "Timing changes between runs.", credit: 0.6 },
          { text: "Timers are buggy.", credit: 0 }
        ]
      },
      { key: "M4", label: "Problem 5: Estimation" },
      {
        key: "M4a",
        parent: "M4",
        label: "5(a) 3,000 customers arrive in the first minute. How many requests per second is that, on average?",
        answer_type: "numeric",
        correct_answer: { value: 50 },
        distractors: [3000, 180, 5],
        points: 2
      },
      mc(
        "M4b",
        "5(b) Which is the best first step to find out why booking is slow under load?",
        ["Rewrite it in another language", "Measure where the time goes", "Add more servers", "Remove the waitlist"],
        "Measure where the time goes",
        2,
        "M4"
      ),
      { key: "M6", label: "Problem 6: Reflection" },
      {
        key: "M6a",
        parent: "M6",
        label: "6(a) Which part of the booking redesign would you build first, and why?",
        answer_type: "free_text",
        points: 4,
        responses: [
          {
            text: "The atomic seat update, because selling a seat twice is the bug customers already see, and every other change depends on seat state being correct.",
            credit: 1
          },
          { text: "The waitlist, because it is a new feature.", credit: 0.4 },
          { text: "All of it at once.", credit: 0 }
        ]
      },
      {
        key: "M6b",
        parent: "M6",
        label: "6(b) What would you ask the theater before committing to your design?",
        answer_type: "free_text",
        points: 4,
        responses: [
          {
            text: "How often a payment times out today, whether customers may hold seats in more than one section at once, and how the waitlist should treat groups.",
            credit: 1
          },
          { text: "What their budget is.", credit: 0.4 },
          { text: "Nothing.", credit: 0 }
        ]
      },
      {
        key: "M6c",
        parent: "M6",
        label: "6(c) What did you learn from a code review you received this semester?",
        answer_type: "free_text",
        points: 3,
        responses: [
          {
            text: "A reviewer pointed out that my method both validated input and saved it, which made it hard to test. Splitting it made both halves simpler.",
            credit: 1
          },
          { text: "To write more comments.", credit: 0.4 }
        ]
      },
      {
        key: "M6d",
        parent: "M6",
        label: "6(d) Is there anything about this exam you would like the grader to know?",
        answer_type: "free_text",
        points: 0,
        responses: [
          { text: "I ran out of time on Problem 4.", credit: 1 },
          { text: "No.", credit: 1 }
        ]
      }
    ]
  },
  {
    // Two-level exam on an instructor-supplied PDF. The papers are scanned and matched;
    // staff have not finished confirming. An earlier upload failed part-way.
    key: "midterm-2",
    title: "Midterm Exam 2",
    slug: "midterm-2",
    assignmentType: "exam",
    delivery: "paper",
    template: "pdf",
    releaseOffsetDays: -9,
    dueOffsetDays: -5,
    batches: [
      { status: "error", fraction: 0.25 },
      { status: "review", fraction: 1 }
    ],
    questions: [
      { key: "S1", label: "Section 1: Collections" },
      {
        key: "S1q1",
        parent: "S1",
        label: "1. Which of these implement java.util.List? Circle all that apply.",
        answer_type: "multiple_choice",
        choices: ["ArrayList", "HashSet", "LinkedList", "TreeMap"],
        correct_answer: { choices: ["ArrayList", "LinkedList"] },
        points: 4
      },
      {
        key: "S1q2",
        parent: "S1",
        label: "2. A suite runs 240 tests in 18 seconds. What is the mean time per test, in milliseconds?",
        answer_type: "numeric",
        correct_answer: { value: 75 },
        grading_tolerance: 1,
        distractors: [13.3, 7.5, 750],
        points: 3
      },
      tf("S1q3", "3. True or false: iterating over a HashMap visits keys in insertion order.", false, 2, "S1"),
      { key: "S2", label: "Section 2: Testing" },
      {
        key: "S2q4",
        parent: "S2",
        label: "4. Which JUnit 5 annotation marks a method that runs before each test?",
        answer_type: "short_answer",
        points: 3,
        responses: [
          { text: "@BeforeEach", credit: 1 },
          { text: "@Before", credit: 0.5 },
          { text: "@BeforeAll", credit: 0 },
          { text: "@Setup", credit: 0 }
        ]
      },
      {
        key: "S2q5",
        parent: "S2",
        label: "5. Write two test cases for a method that validates email addresses, and say what each one checks.",
        answer_type: "free_text",
        points: 8,
        responses: [
          {
            text: 'assertTrue(isValid("a.b@example.com")) checks a normal address with a dot in the local part. assertFalse(isValid("ab@")) checks that a missing domain is rejected.',
            credit: 1
          },
          { text: "Test a valid email returns true and an invalid email returns false.", credit: 0.5 },
          { text: "assertEquals(true, isValid(email))", credit: 0.25 }
        ]
      },
      {
        key: "S2q6",
        parent: "S2",
        label: "6. What is a flaky test? Give one common cause.",
        answer_type: "free_text",
        points: 5,
        responses: [
          {
            text: "A test that passes and fails on the same code. Common causes are depending on test order, timing with threads or sleeps, and shared state between tests.",
            credit: 1
          },
          { text: "A test that fails sometimes, usually because of timing.", credit: 0.7 },
          { text: "A test with a bug in it.", credit: 0.2 }
        ]
      }
    ]
  },
  {
    // The final: the instructor has uploaded the PDF but not defined questions or regions.
    key: "final",
    title: "Final Exam",
    slug: "final-exam",
    assignmentType: "exam",
    delivery: "paper",
    template: "pdf-only",
    releaseOffsetDays: 18,
    dueOffsetDays: 20,
    questions: [
      { key: "F1", label: "Problem 1: Software Architecture" },
      {
        key: "F1a",
        parent: "F1",
        label: "Sketch a layered architecture for a course registration system and name each layer's responsibility.",
        answer_type: "free_text",
        points: 15
      },
      { key: "F2", label: "Problem 2: Concurrency" },
      {
        key: "F2a",
        parent: "F2",
        label: "Explain a race condition in the code shown and how to fix it.",
        answer_type: "free_text",
        points: 15
      },
      mc(
        "F2b",
        "Which construct makes a block mutually exclusive in Java?",
        ["volatile", "synchronized", "final", "transient"],
        "synchronized",
        5,
        "F2"
      )
    ]
  },
  {
    // One-page flat quiz on paper; the scan is uploaded and waiting to be processed.
    key: "pop-quiz",
    title: "Pop Quiz: Inheritance",
    slug: "pop-quiz-inheritance",
    assignmentType: "exam",
    delivery: "paper",
    template: "generated",
    releaseOffsetDays: -2,
    dueOffsetDays: -1,
    batches: [{ status: "uploaded", fraction: 1 }],
    questions: [
      mc(
        "P1",
        "1. Which keyword prevents a method from being overridden?",
        ["static", "final", "private", "sealed"],
        "final",
        1
      ),
      tf("P2", "2. True or false: an abstract class can have a constructor.", true, 1),
      {
        key: "P3",
        label: "3. What does the L in SOLID stand for?",
        answer_type: "short_answer",
        points: 2,
        responses: [
          { text: "Liskov Substitution Principle", credit: 1 },
          { text: "Liskov", credit: 0.5 },
          { text: "Law of Demeter", credit: 0 }
        ]
      }
    ]
  },
  {
    // Flat in-app quiz, objective questions only, so autograding produces the whole score.
    key: "quiz-1",
    title: "Quiz 1: Algorithms Warm-up",
    slug: "quiz-1",
    assignmentType: "quiz",
    delivery: "in_app",
    template: "generated",
    releaseOffsetDays: -28,
    dueOffsetDays: -21,
    attempts: { submitRate: 0.9, retakeRate: 0.25 },
    grading: { completedFraction: 1, release: true },
    questions: [
      mc(
        "Q1",
        "What is the time complexity of binary search on a sorted array?",
        ["O(1)", "O(log n)", "O(n)", "O(n log n)"],
        "O(log n)",
        2
      ),
      mc(
        "Q2",
        "Which design pattern notifies dependents when an object changes?",
        ["Singleton", "Observer", "Adapter", "Builder"],
        "Observer",
        2
      ),
      tf("Q3", "Java interfaces may declare default methods.", true, 1),
      {
        key: "Q4",
        label: "How many edges does a complete graph on 6 vertices have?",
        answer_type: "numeric",
        correct_answer: { value: 15 },
        distractors: [30, 12, 36],
        points: 2
      },
      {
        key: "Q5",
        label: "What is log2(1000), to two decimal places?",
        answer_type: "numeric",
        correct_answer: { value: 9.97 },
        grading_tolerance: 0.05,
        distractors: [10, 3, 9.5],
        points: 2
      },
      tf("Q6", "A HashSet can hold duplicate elements.", false, 1)
    ]
  },
  {
    // Two-level in-app quiz mixing autograded and hand-graded questions; grading is in progress.
    key: "quiz-2",
    title: "Quiz 2: Design and Process",
    slug: "quiz-2",
    assignmentType: "quiz",
    delivery: "in_app",
    template: "generated",
    releaseOffsetDays: -12,
    dueOffsetDays: -7,
    attempts: { submitRate: 0.8, retakeRate: 0.1 },
    grading: { completedFraction: 0.6, release: false },
    questions: [
      { key: "C", label: "Part 1: Concepts" },
      mc(
        "C1",
        "Which principle says a class should have only one reason to change?",
        ["Single Responsibility", "Open/Closed", "Liskov Substitution", "Dependency Inversion"],
        "Single Responsibility",
        2,
        "C"
      ),
      tf("C2", "Composition is usually preferred over inheritance for reusing code.", true, 1, "C"),
      { key: "R", label: "Part 2: Short Responses" },
      {
        key: "R1",
        parent: "R",
        label: "Which git command records staged changes in the repository?",
        answer_type: "short_answer",
        points: 2,
        responses: [
          { text: "git commit", credit: 1 },
          { text: "commit", credit: 1 },
          { text: "git add", credit: 0 },
          { text: "git push", credit: 0 }
        ]
      },
      {
        key: "R2",
        parent: "R",
        label: "What is code review for, besides finding bugs?",
        answer_type: "free_text",
        points: 5,
        responses: [
          {
            text: "Sharing knowledge of the codebase, keeping style and design consistent, and making sure someone besides the author can maintain the change.",
            credit: 1
          },
          { text: "Learning from teammates and keeping the code readable.", credit: 0.7 },
          { text: "Getting approval to merge.", credit: 0.3 }
        ]
      },
      {
        key: "N",
        label: "How many bits are in a byte?",
        answer_type: "numeric",
        correct_answer: { value: 8 },
        distractors: [4, 16, 1024],
        points: 1
      }
    ]
  },
  {
    // In-app quiz that is authored but not yet released to students.
    key: "quiz-3",
    title: "Quiz 3: Concurrency",
    slug: "quiz-3",
    assignmentType: "quiz",
    delivery: "in_app",
    template: "generated",
    releaseOffsetDays: 5,
    dueOffsetDays: 8,
    questions: [
      mc(
        "T1",
        "Which interface represents a task that returns a value?",
        ["Runnable", "Callable", "Thread", "Executor"],
        "Callable",
        2
      ),
      tf("T2", "Calling run() on a Thread starts a new thread.", false, 1),
      mc(
        "T3",
        "Which collection is safe to share between threads without external locking?",
        ["ArrayList", "HashMap", "ConcurrentHashMap", "LinkedList"],
        "ConcurrentHashMap",
        2
      )
    ]
  }
];
