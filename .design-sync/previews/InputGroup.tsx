import { InputGroup, Input, Stack, Box, Text } from "@pawtograder/webapp";
import { LuSearch, LuGithub, LuPercent, LuMail } from "react-icons/lu";

export const WithStartIcon = () => (
  <Box maxW="360px">
    <InputGroup startElement={<LuSearch />}>
      <Input placeholder="Search students…" />
    </InputGroup>
  </Box>
);

export const WithEndElement = () => (
  <Box maxW="360px">
    <InputGroup endElement={<LuPercent />}>
      <Input placeholder="Late penalty" defaultValue="15" />
    </InputGroup>
  </Box>
);

export const WithSuffixText = () => (
  <Box maxW="360px">
    <InputGroup endElement={<Text color="fg.muted">points</Text>}>
      <Input defaultValue="100" />
    </InputGroup>
  </Box>
);

export const Examples = () => (
  <Stack gap={4} maxW="360px">
    <InputGroup startElement={<LuGithub />}>
      <Input placeholder="github-username" defaultValue="octocat" />
    </InputGroup>
    <InputGroup startElement={<LuMail />}>
      <Input placeholder="student@northeastern.edu" />
    </InputGroup>
    <InputGroup startElement={<LuSearch />} endElement={<Text color="fg.muted">42</Text>}>
      <Input placeholder="Filter submissions" />
    </InputGroup>
  </Stack>
);
