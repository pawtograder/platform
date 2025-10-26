"use client";

import { Box, Flex } from "@chakra-ui/react";
import { useState } from "react";
import DiscussionThreadList from "./DiscussionThreadList";

const DiscussionLayout = ({ children }: Readonly<{ children: React.ReactNode }>) => {
  const [listWidth, setListWidth] = useState(450);

  const handleMouseDown = (e: React.MouseEvent) => {
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
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

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
          transition="background 0.2s"
          height="100%"
          position="relative"
          onMouseDown={handleMouseDown}
          userSelect="none"
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
