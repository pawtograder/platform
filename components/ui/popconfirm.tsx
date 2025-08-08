import { HStack, Icon, IconButton, Text } from "@chakra-ui/react";
import { useCallback, useRef, useState } from "react";
import { BsCheck, BsX } from "react-icons/bs";
import { PopoverBody, PopoverContent, PopoverHeader, PopoverRoot, PopoverTrigger } from "./popover";

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
  onConfirm: () => Promise<void>;
  onCancel?: () => Promise<void>;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const isExecutingRef = useRef(false);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  const handleConfirm = useCallback(
    (e: React.MouseEvent) => {
      // Safari-specific: Prevent default and stop propagation immediately
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.preventDefault();
      e.nativeEvent.stopImmediatePropagation();

      // Prevent double-clicks
      if (isLoading || isExecutingRef.current) return;

      isExecutingRef.current = true;
      setIsLoading(true);

      // Close the popover FIRST to avoid the original click being treated as an
      // outside interaction for any dialog opened by onConfirm (immediate-close bug)
      setIsOpen(false);

      // Defer the confirm action slightly so the popover fully unmounts
      setTimeout(async () => {
        try {
          await onConfirm();
        } catch (error) {
          console.error("Error in confirm action:", error);
        } finally {
          setIsLoading(false);
          isExecutingRef.current = false;
        }
      }, 75);
    },
    [onConfirm, isLoading]
  );

  const handleCancel = useCallback(
    (e: React.MouseEvent) => {
      // Safari-specific: Prevent default and stop propagation immediately
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.preventDefault();
      e.nativeEvent.stopImmediatePropagation();

      // Prevent double-clicks
      if (isLoading || isExecutingRef.current) return;

      isExecutingRef.current = true;
      setIsLoading(true);

      // Use setTimeout to break out of the current call stack - Safari friendly
      setTimeout(async () => {
        try {
          if (onCancel) {
            await onCancel();
          }
          // Close with a delay to ensure Safari processes the action
          setTimeout(() => {
            setIsOpen(false);
            setIsLoading(false);
            isExecutingRef.current = false;
          }, 50);
        } catch (error) {
          console.error("Error in cancel action:", error);
          setIsLoading(false);
          isExecutingRef.current = false;
        }
      }, 0);
    },
    [onCancel, isLoading]
  );

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
              ref={cancelButtonRef}
              onClick={handleCancel}
              onMouseDown={handleCancel} // Safari fallback
              aria-label="Cancel action"
              variant="ghost"
              size="sm"
              disabled={isLoading}
              style={{
                // Safari-specific fixes
                WebkitTouchCallout: "none",
                WebkitUserSelect: "none",
                WebkitTapHighlightColor: "transparent",
                cursor: "pointer"
              }}
            >
              <Icon as={BsX} boxSize={5} />
            </IconButton>
            <IconButton
              ref={confirmButtonRef}
              onClick={handleConfirm}
              onMouseDown={handleConfirm} // Safari fallback
              aria-label="Confirm action"
              variant="solid"
              size="sm"
              loading={isLoading}
              style={{
                // Safari-specific fixes
                WebkitTouchCallout: "none",
                WebkitUserSelect: "none",
                WebkitTapHighlightColor: "transparent",
                cursor: "pointer"
              }}
            >
              <Icon as={BsCheck} boxSize={5} />
            </IconButton>
          </HStack>
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
};
