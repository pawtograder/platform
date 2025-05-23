import { IconButton, Text, HStack } from "@chakra-ui/react";
import { Icon } from "@chakra-ui/react";
import { PopoverRoot, PopoverTrigger, PopoverContent, PopoverHeader, PopoverBody } from "./popover";
import { BsCheck, BsX } from "react-icons/bs";
import { useState } from "react";

export const PopConfirm = ({
  triggerLabel,
  trigger,
  confirmHeader,
  confirmText,
  onConfirm,
  onCancel
}: {
  triggerLabel: string;
  trigger: React.ReactNode;
  confirmHeader: string;
  confirmText: string;
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <PopoverRoot closeOnInteractOutside={true} open={isOpen} onOpenChange={(details) => setIsOpen(details.open)}>
      <PopoverTrigger aria-label={triggerLabel} asChild>
        {trigger}
      </PopoverTrigger>
      <PopoverContent>
        <PopoverHeader>{confirmHeader}</PopoverHeader>
        <PopoverBody>
          <Text mb={2}>{confirmText}</Text>
          <HStack justify="flex-end" gap={2}>
            <IconButton
              onClick={() => {
                onCancel();
                setIsOpen(false);
              }}
              aria-label="Cancel action"
              variant="ghost"
              size="sm"
            >
              <Icon as={BsX} boxSize={5} />
            </IconButton>
            <IconButton
              onClick={() => {
                onConfirm();
                setIsOpen(false);
              }}
              aria-label="Confirm action"
              variant="solid"
              size="sm"
            >
              <Icon as={BsCheck} boxSize={5} />
            </IconButton>
          </HStack>
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
};
