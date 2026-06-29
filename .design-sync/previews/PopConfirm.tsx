import {
  PopoverRoot,
  PopoverContent,
  PopoverHeader,
  PopoverBody,
  PopoverTrigger,
  Button,
  HStack,
  Text,
  Icon,
  IconButton
} from "@pawtograder/webapp";
import { BsCheck, BsX } from "react-icons/bs";

// PopConfirm manages `open` via internal state and cannot be forced open via a
// prop. These cells reproduce its exact composition (PopoverRoot + confirm
// header/body + ghost Cancel / solid Confirm icon buttons) in the open state.

export const RemoveFromGroupConfirm = () => (
  <PopoverRoot open positioning={{ placement: "bottom-start" }}>
    <PopoverTrigger asChild>
      <Button variant="outline" colorPalette="red" size="sm">
        Remove from group
      </Button>
    </PopoverTrigger>
    <PopoverContent portalled={false}>
      <PopoverHeader>Remove Daniel Reyes?</PopoverHeader>
      <PopoverBody>
        <Text mb={2}>
          They will lose access to the shared repo for Problem Set 5. This cannot be undone.
        </Text>
        <HStack justify="flex-end" gap={2}>
          <IconButton aria-label="Cancel action" variant="ghost" size="sm">
            <Icon as={BsX} boxSize={5} />
          </IconButton>
          <IconButton aria-label="Confirm action" variant="solid" colorPalette="red" size="sm">
            <Icon as={BsCheck} boxSize={5} />
          </IconButton>
        </HStack>
      </PopoverBody>
    </PopoverContent>
  </PopoverRoot>
);

export const DeleteSubmissionConfirm = () => (
  <PopoverRoot open positioning={{ placement: "bottom-start" }}>
    <PopoverTrigger asChild>
      <Button variant="outline" colorPalette="red" size="sm">
        Delete submission
      </Button>
    </PopoverTrigger>
    <PopoverContent portalled={false}>
      <PopoverHeader>Delete this submission?</PopoverHeader>
      <PopoverBody>
        <Text mb={2}>
          Submission #4 for &ldquo;Recursion Lab&rdquo; will be permanently removed and the
          autograder score discarded.
        </Text>
        <HStack justify="flex-end" gap={2}>
          <IconButton aria-label="Cancel action" variant="ghost" size="sm">
            <Icon as={BsX} boxSize={5} />
          </IconButton>
          <IconButton aria-label="Confirm action" variant="solid" colorPalette="red" size="sm">
            <Icon as={BsCheck} boxSize={5} />
          </IconButton>
        </HStack>
      </PopoverBody>
    </PopoverContent>
  </PopoverRoot>
);
