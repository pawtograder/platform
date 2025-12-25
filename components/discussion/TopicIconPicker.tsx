"use client";

import { Field } from "@chakra-ui/react";
import { HStack, NativeSelect, Text } from "@chakra-ui/react";
import { TopicIcon, TOPIC_ICON_OPTIONS, TopicIconName } from "./TopicIcon";

export type TopicIconPickerValue = TopicIconName | "";

export function TopicIconPicker({
  value,
  onChange,
  label = "Icon",
  helperText = "Choose an icon to represent this topic",
  placeholder = "No icon"
}: {
  value: TopicIconPickerValue;
  onChange: (value: TopicIconPickerValue) => void;
  label?: string;
  helperText?: string;
  placeholder?: string;
}) {
  return (
    <Field.Root>
      <Field.Label>{label}</Field.Label>
      <HStack gap="3">
        <NativeSelect.Root flex="1">
          <NativeSelect.Field value={value} onChange={(e) => onChange((e.target.value as TopicIconPickerValue) || "")}>
            <option value="">{placeholder}</option>
            {TOPIC_ICON_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </NativeSelect.Field>
        </NativeSelect.Root>
        <HStack minW="56px" justify="flex-end">
          <TopicIcon name={value || null} boxSize="5" />
        </HStack>
      </HStack>
      <Field.HelperText>
        <Text color="fg.muted" fontSize="sm">
          {helperText}
        </Text>
      </Field.HelperText>
    </Field.Root>
  );
}
