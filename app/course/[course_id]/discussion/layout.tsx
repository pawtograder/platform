"use client";

import { Box, Flex } from "@chakra-ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import DiscussionThreadList from "./DiscussionThreadList";

const DiscussionLayout = ({ children }: Readonly<{ children: React.ReactNode }>) => {
  const [listWidth, setListWidth] = useState(320);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Cleanup effect - removes listeners if component unmounts during drag
  useEffect(() => {
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = listWidth;

      const handleMouseMove = (e: MouseEvent) => {
        const newWidth = Math.max(300, Math.min(800, startWidth + (e.clientX - startX)));
        setListWidth(newWidth);
      };

      const handleMouseUp = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        cleanupRef.current = null;
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);

      // Store cleanup function in ref so it can be called on unmount
      cleanupRef.current = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };
    },
    [listWidth]
  );

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 50 : 10; // Larger steps with Shift key

    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setListWidth((prev) => Math.max(300, prev - step));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setListWidth((prev) => Math.min(800, prev + step));
    } else if (e.key === "Home") {
      e.preventDefault();
      setListWidth(300); // Min width
    } else if (e.key === "End") {
      e.preventDefault();
      setListWidth(800); // Max width
    }
  }, []);

  return (
    <Box height="100dvh" overflow="hidden">
      <Flex flex="1" wrap={{ base: "wrap", md: "nowrap" }} height="100%" minHeight="0">
        {/* Discussion Thread List */}
        <Box
          width={{ base: "100%", md: `${listWidth}px` }}
          borderRightWidth={{ base: "0", md: "1px" }}
          borderBottomWidth={{ base: "1px", md: "0" }}
          borderStyle="solid"
          borderColor="border.emphasized"
          pt="4"
          height="100%"
          overflow="hidden"
          position="relative"
        >
          <DiscussionThreadList />
        </Box>

        {/* Draggable Divider - Only visible on desktop */}
        <Box
          display={{ base: "none", md: "block" }}
          width="4px"
          cursor="ew-resize"
          bg="transparent"
          _hover={{ bg: "blue.500" }}
          _focusVisible={{
            bg: "blue.600",
            outline: "2px solid",
            outlineColor: "blue.500",
            outlineOffset: "2px"
          }}
          transition="background 0.2s"
          height="100%"
          position="relative"
          onMouseDown={handleMouseDown}
          onKeyDown={handleKeyDown}
          userSelect="none"
          tabIndex={0}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize discussion panel"
          aria-valuenow={listWidth}
          aria-valuemin={300}
          aria-valuemax={800}
          aria-valuetext={`Discussion panel width: ${listWidth} pixels`}
        />

        {/* Main Content */}
        <Box p={{ base: "4", md: "8" }} flex="1" height="100%" overflow="auto">
          {children}
        </Box>
      </Flex>
    </Box>
  );
};

export default DiscussionLayout;
