"use client";

import { TagColor } from "@/app/course/[course_id]/manage/course/enrollments/TagColors";
import TagDisplay from "@/components/ui/tag";
import useTags from "@/hooks/useTags";
import { Tag } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Flex, Heading, Icon, SegmentGroup } from "@chakra-ui/react";
import { Select } from "chakra-react-select";
import { useEffect, useRef, useState } from "react";
import { FaPlus } from "react-icons/fa6";

interface TagOption {
  label: string;
  value: string;
  tag?: Tag;
}

function KeyboardAwareSegmentGroup({
  onKeyDown,
  children
}: {
  onKeyDown: (e: KeyboardEvent) => void;
  children: React.ReactNode;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      onKeyDown(e);
    };

    const wrapper = wrapperRef.current;
    if (wrapper) {
      wrapper.addEventListener("keydown", handleKeyDown);
      wrapper.focus();
    }

    return () => {
      if (wrapper) {
        wrapper.removeEventListener("keydown", handleKeyDown);
      }
    };
  }, [onKeyDown]);

  return (
    <Box ref={wrapperRef} tabIndex={0} outline="none" _focus={{ outline: "none" }}>
      {children}
    </Box>
  );
}

export default function InlineAddTag({
  addTag,
  currentTags
}: {
  addTag: (name: string, color: string) => void;
  currentTags: Tag[];
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [selectedColor, setSelectedColor] = useState<string>("gray");
  const inputRef = useRef<HTMLInputElement>(null);
  const { tags } = useTags();

  // Get unique tag names for autocomplete
  const uniqueTags: TagOption[] = Array.from(
    tags
      .reduce((map, tag) => {
        if (
          !map.has(tag.name + tag.color + tag.visible) &&
          !currentTags.some((t) => t.name === tag.name && t.color === tag.color && t.visible === tag.visible)
        ) {
          map.set(tag.name + tag.color + tag.visible, tag);
        }
        return map;
      }, new Map())
      .values()
  ).map((tag) => ({ label: tag.name, value: tag.name, tag }));

  const allColors = ["gray", ...TagColor.colors().map((c) => c.toString())];

  const handleColorChange = (color: string, shouldSubmit: boolean = false) => {
    setSelectedColor(color);
    if (shouldSubmit) {
      handleSubmit(inputValue, color);
    }
  };

  const handleArrowKey = (direction: "left" | "right") => {
    const currentIndex = allColors.indexOf(selectedColor);
    let newIndex;
    if (direction === "left") {
      newIndex = currentIndex <= 0 ? allColors.length - 1 : currentIndex - 1;
    } else {
      newIndex = currentIndex >= allColors.length - 1 ? 0 : currentIndex + 1;
    }
    handleColorChange(allColors[newIndex], false);
  };

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);

  const handleSubmit = (value: string, color: string) => {
    if (value.trim()) {
      addTag(value.trim(), color);
      setInputValue("");
      setShowColorPicker(false);
      setIsEditing(false);
    }
  };

  const handleTagSelect = (value: string) => {
    // Check if this is an existing tag
    const existingTag = uniqueTags.find((t) => t.value === value)?.tag;
    if (existingTag) {
      // If it's an existing tag, use its color
      handleSubmit(value, existingTag.color);
    } else {
      // If it's a new tag, show color picker
      setInputValue(value);
      setShowColorPicker(true);
    }
  };

  if (!isEditing) {
    return (
      <Button size="xs" variant="ghost" onClick={() => setIsEditing(true)} minW="24px" h="24px" p="0">
        <Icon as={FaPlus} boxSize="12px" />
      </Button>
    );
  }

  return (
    <Flex direction="column" gap={2} w="150px">
      {!showColorPicker ? (
        <Select<TagOption>
          autoFocus
          isMulti={false}
          options={uniqueTags}
          value={inputValue ? { label: inputValue, value: inputValue } : null}
          onChange={(option) => {
            if (option) {
              handleTagSelect(option.value);
            }
          }}
          onInputChange={(value) => setInputValue(value)}
          onBlur={() => {
            if (inputValue.trim()) {
              handleTagSelect(inputValue);
            }
            setIsEditing(false);
            setInputValue("");
            setShowColorPicker(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && inputValue.trim()) {
              handleTagSelect(inputValue);
            } else if (e.key === "Escape") {
              setIsEditing(false);
              setInputValue("");
              setShowColorPicker(false);
            }
          }}
          placeholder="Add tag..."
          size="sm"
          menuIsOpen={true}
          chakraStyles={{
            container: (provided) => ({
              ...provided,
              minWidth: "150px",
              width: "100%"
            })
          }}
          components={{
            Option: ({ data, ...props }) => (
              <Box {...props.innerProps} p="4px 8px" cursor="pointer" _hover={{ bg: "gray.100" }}>
                {data.tag ? <TagDisplay tag={data.tag} /> : <div>{data.label}</div>}
              </Box>
            ),
            SingleValue: ({ data, ...props }) => (
              <Box {...props.innerProps} p="4px 8px" cursor="pointer">
                {data.tag ? <TagDisplay tag={data.tag} /> : <div>{data.label}</div>}
              </Box>
            )
          }}
        />
      ) : (
        <Flex direction="column" gap={2}>
          <Heading size="xs">Tag color</Heading>
          <KeyboardAwareSegmentGroup
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setIsEditing(false);
                setInputValue("");
                setShowColorPicker(false);
              } else if (e.key === "Enter" && inputValue.trim()) {
                handleSubmit(inputValue, selectedColor);
              } else if (e.key === "ArrowLeft") {
                handleArrowKey("left");
              } else if (e.key === "ArrowRight") {
                handleArrowKey("right");
              }
            }}
          >
            <SegmentGroup.Root
              value={selectedColor}
              onValueChange={(details) => {
                handleColorChange(details.value, true);
              }}
              size="xs"
            >
              <SegmentGroup.Indicator />
              <SegmentGroup.Item
                value="gray"
                border="1px solid"
                borderColor={selectedColor === "gray" ? "gray.500" : "transparent"}
                onClick={() => handleColorChange("gray", true)}
              >
                <SegmentGroup.ItemHiddenInput />
              </SegmentGroup.Item>
              {TagColor.colors().map((color) => (
                <SegmentGroup.Item
                  key={color.toString()}
                  value={color.toString()}
                  bg={selectedColor === color.toString() ? `${color.toString()}.500` : `${color.toString()}.200`}
                  onClick={() => handleColorChange(color.toString(), true)}
                >
                  <SegmentGroup.ItemHiddenInput />
                </SegmentGroup.Item>
              ))}
            </SegmentGroup.Root>
          </KeyboardAwareSegmentGroup>
        </Flex>
      )}
    </Flex>
  );
}
