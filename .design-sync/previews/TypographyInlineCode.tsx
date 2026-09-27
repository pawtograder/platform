import { TypographyInlineCode, Text } from "@pawtograder/webapp";

export const InSentence = () => (
  <Text>
    Install the dependency with <TypographyInlineCode /> before running the autograder.
  </Text>
);

export const Standalone = () => <TypographyInlineCode />;
