import {
  DrawerRoot,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerBody,
  DrawerFooter,
  DrawerCloseTrigger,
  Button,
  Stack,
  HStack,
  Text,
  Badge,
  Field,
  Input,
  Textarea
} from "@pawtograder/webapp";

export const RegradeRequestDrawer = () => (
  <DrawerRoot open size="md">
    <DrawerContent portalled={false}>
      <DrawerHeader>
        <DrawerTitle>Request a regrade</DrawerTitle>
      </DrawerHeader>
      <DrawerBody>
        <Stack gap={4}>
          <HStack justify="space-between">
            <Text fontWeight="medium">Problem Set 4 — Binary Search Trees</Text>
            <Badge colorPalette="orange">Open</Badge>
          </HStack>
          <Field label="Rubric item in dispute">
            <Input defaultValue="In-order traversal correctness (8 pts)" />
          </Field>
          <Field label="Why do you think this was graded incorrectly?">
            <Textarea
              rows={4}
              defaultValue="The autograder marked test_inorder as failing, but my output matches the expected sequence when run locally."
            />
          </Field>
        </Stack>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="outline">Cancel</Button>
        <Button colorPalette="blue">Submit request</Button>
      </DrawerFooter>
      <DrawerCloseTrigger />
    </DrawerContent>
  </DrawerRoot>
);

export const StudentDetailsDrawer = () => (
  <DrawerRoot open size="sm">
    <DrawerContent portalled={false}>
      <DrawerHeader>
        <DrawerTitle>Student details</DrawerTitle>
      </DrawerHeader>
      <DrawerBody>
        <Stack gap={3}>
          <Stack gap={0}>
            <Text fontSize="lg" fontWeight="semibold">
              Priya Natarajan
            </Text>
            <Text color="fg.muted" fontSize="sm">
              pnatarajan@northeastern.edu
            </Text>
          </Stack>
          <HStack gap={2}>
            <Badge colorPalette="green">Enrolled</Badge>
            <Badge variant="outline">Section 03</Badge>
            <Badge variant="outline">Lab L08</Badge>
          </HStack>
          <Stack gap={1}>
            <HStack justify="space-between">
              <Text color="fg.muted" fontSize="sm">
                Submissions
              </Text>
              <Text fontSize="sm">7 of 9</Text>
            </HStack>
            <HStack justify="space-between">
              <Text color="fg.muted" fontSize="sm">
                Current grade
              </Text>
              <Text fontSize="sm">91.4%</Text>
            </HStack>
            <HStack justify="space-between">
              <Text color="fg.muted" fontSize="sm">
                GitHub
              </Text>
              <Text fontSize="sm">@priya-n</Text>
            </HStack>
          </Stack>
        </Stack>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost">Message</Button>
        <Button colorPalette="blue">View gradebook</Button>
      </DrawerFooter>
      <DrawerCloseTrigger />
    </DrawerContent>
  </DrawerRoot>
);
