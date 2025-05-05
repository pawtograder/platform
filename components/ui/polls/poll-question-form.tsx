"use client";
import { PollQuestionWithAnswers } from "@/utils/supabase/DatabaseTypes";
import { Card, HStack, Progress, Text, VStack } from "@chakra-ui/react";

export function PollQuestionForm({ question }: { question: PollQuestionWithAnswers }) {
  // const createAnswer = useCreate<PollResponseAnswer>({
  //     resource: "poll_response_answers",
  // });

  question.poll_question_answers.sort((a, b) => a.ordinal - b.ordinal);
  return (
    <Card.Root>
      <Card.Header>
        <Card.Title>{question.title}</Card.Title>
      </Card.Header>
      <Card.Body>
        <VStack align="stretch">
          {question.poll_question_answers.map((answer) => (
            <HStack
              key={answer.id}
              borderWidth="1px"
              _hover={{ bg: "bg.subtle" }}
              borderColor="border.emphasized"
              p={2}
              borderRadius="md"
            >
              <Text>{answer.ordinal}</Text>
              <Text>{answer.title}</Text>
              <Progress.Root defaultValue={10} maxW="lg">
                <Progress.Track>
                  <Progress.Range />
                </Progress.Track>
              </Progress.Root>
            </HStack>
          ))}
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}
