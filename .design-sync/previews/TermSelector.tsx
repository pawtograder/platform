import { useState } from "react";
import { TermSelector, Box } from "@pawtograder/webapp";

export const Default = () => {
  const [term, setTerm] = useState(202630);
  return (
    <Box w="320px">
      <TermSelector value={term} onChange={setTerm} />
    </Box>
  );
};

export const Required = () => {
  const [term, setTerm] = useState(202610);
  return (
    <Box w="320px">
      <TermSelector value={term} onChange={setTerm} label="Enrollment term" required />
    </Box>
  );
};
