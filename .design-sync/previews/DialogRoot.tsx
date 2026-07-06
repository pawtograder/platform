import {
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogActionTrigger,
  DialogCloseTrigger,
  Button,
  Text
} from "@pawtograder/webapp";

export const ConfirmRelease = () => (
  <DialogRoot open size="md">
    <DialogContent portalled={false}>
      <DialogHeader>
        <DialogTitle>Release grades?</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <DialogDescription>
          This will notify all 142 students that their Problem Set 3 grades are available. This
          action cannot be undone.
        </DialogDescription>
      </DialogBody>
      <DialogFooter>
        <DialogActionTrigger asChild>
          <Button variant="outline">Cancel</Button>
        </DialogActionTrigger>
        <Button colorPalette="green">Release grades</Button>
      </DialogFooter>
      <DialogCloseTrigger />
    </DialogContent>
  </DialogRoot>
);

export const FormDialog = () => (
  <DialogRoot open size="md">
    <DialogContent portalled={false}>
      <DialogHeader>
        <DialogTitle>Request a regrade</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <Text>
          Briefly explain why you believe this submission was graded incorrectly. Your instructor
          will review the request.
        </Text>
      </DialogBody>
      <DialogFooter>
        <DialogActionTrigger asChild>
          <Button variant="outline">Cancel</Button>
        </DialogActionTrigger>
        <Button colorPalette="blue">Submit request</Button>
      </DialogFooter>
      <DialogCloseTrigger />
    </DialogContent>
  </DialogRoot>
);
