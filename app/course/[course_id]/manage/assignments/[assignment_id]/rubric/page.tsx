import { Accordion } from "@chakra-ui/react";
import RubricElement from "./rubricElement";

export enum RubricType {
  "student",
  "grader"
}

export default function RubricPage() {
  const rubrics = [
    { title: "Student Rubric", content: <RubricElement type={RubricType.student} /> },
    { title: "Grader Rubric", content: <RubricElement type={RubricType.grader} /> }
  ];

  return (
    <Accordion.Root lazyMount unmountOnExit collapsible>
      {rubrics.map((item, index) => (
        <Accordion.Item key={index} value={item.title}>
          <Accordion.ItemTrigger>
            {item.title}
            <Accordion.ItemIndicator color="black" />
          </Accordion.ItemTrigger>
          <Accordion.ItemContent>
            <Accordion.ItemBody>{item.content}</Accordion.ItemBody>
          </Accordion.ItemContent>
        </Accordion.Item>
      ))}
    </Accordion.Root>
  );
}
