// Poll question structure - a single question object
export type PollQuestion = {
  id: string;
};

export type MultipleChoicePollQuestion = PollQuestion & {
  type: "multiple-choice";
  prompt: string;
  choices: {
    label: string;
  }[];
  correct_choices: string[];
};

// Poll response format: { "poll_question_0": "Dynamic Programming" }
// Keys are dynamic (poll_question_0, poll_question_1, etc.)
// Values can be string (single choice) or string[] (multiple choice)
export type PollResponseData = Record<string, string | string[]>;
