# Discovery interviews: Office Hours Ticket Escalation

Interview notes behind [`prd-oh-escalation.md`](prd-oh-escalation.md). We interviewed one TA and one student.

## Interview 1: TA

Participant: P1, TA for an intro CS course (2nd semester as TA).
Format: 20 min, video call.

### Key quotes

- "Probably once a shift I get a question I just can't answer, usually something about the autograder config or a regrade policy only the head TA knows."
- "I tell them to rejoin the queue and I feel bad about it. They've already waited 40 minutes."
- "The next TA has no idea I already checked their environment setup, so they start from scratch."
- "Half the time the fix takes two minutes. It's just a matter of getting it to the right person."

### Notes

- Currently handles it by messaging other staff on Slack, which is inconsistent and often missed.
- Doesn't always know which staff member would know the answer.
- Wants to pass along what was already tried, without writing a long message.

## Interview 2: Student

Participant: P2, sophomore, took two courses using the platform.
Format: 15 min, in person.

### Key quotes

- "I waited an hour, the TA couldn't figure it out, and they told me to get back in line."
- "When I finally got someone else, I had to explain everything again."
- "Sometimes a TA marks it done but my problem isn't actually fixed, and there's no way to say that."
- "I've just given up and gone to the professor's email instead."

### Notes

- Rejoining the queue felt like being penalized for asking a hard question.
- Repeating context to each new TA was a major frustration.
- Wanted a way to flag "still not fixed" without starting over.

## Shared themes

1. Unresolved questions go to the back of the queue, so students wait twice.
2. Context is lost between staff members.
3. There's no way to confirm a problem is actually fixed after a ticket closes.

## How the design answers each theme

| Theme                   | What V1 does                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Students wait twice     | An escalated ticket returns to the queue ahead of normal tickets, so the student doesn't start over at the back.                                                                |
| Context is lost         | The escalation note (up to 500 characters, so a short handoff rather than a long message) and the history of who already helped appear on the ticket for the next staff member. |
| No way to confirm a fix | After staff press Resolve, the student has 10 minutes to answer "Did your problem get fixed?". Answering No escalates the ticket with the student's note.                       |

P1 often doesn't know which staff member has the answer, and some questions only the head TA can answer. V1 doesn't route tickets to a person (see Non-goals in the PRD). An escalated ticket sits at the top of the queue for every staff member, so the head TA or an instructor can claim it. This gives P1 a way to hand off inside the queue instead of the Slack messages they send today, which are often missed.

## Limits and open questions

- Two interviews, one per role, is a small sample. Usability testing of the check-in wording (see "Open questions and risks" in the PRD) should include more students.
- P2 sometimes skips office hours and emails the professor. V1 doesn't measure whether escalation reduces that.
