"use client";

import { Box, Flex } from "@chakra-ui/react";
import dynamic from "next/dynamic";
import { forwardRef } from "react";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { DEFAULT_USER_PREFERENCES } from "@/types/UserPreferences";
import { Skeleton } from "./skeleton";
import { Switch } from "./switch";
import {
  formatPoints,
  isRubricCheckDataWithOptions,
  type CodeFileHandle,
  type CodeFileProps,
  type RubricCheckSelectOption,
  type RubricCheckSubOptions,
  type RubricCriteriaSelectGroupOption
} from "./code-file-shared";

export type {
  CodeFileHandle,
  CodeFileProps,
  RubricCriteriaSelectGroupOption,
  RubricCheckSelectOption,
  RubricCheckSubOptions
};
export { formatPoints, isRubricCheckDataWithOptions };
export type { RubricCheckSubOption, RubricCheckDataWithOptions } from "./code-file-shared";

const CodeFileMonaco = dynamic(() => import("./code-file-monaco"), {
  ssr: false,
  loading: () => <Skeleton height="600px" width="100%" />
});

const CodeFilePlain = dynamic(() => import("./code-file-plain"), {
  ssr: false,
  loading: () => <Skeleton height="600px" width="100%" />
});

const CodeFileStarryNight = dynamic(() => import("./code-file-starry-night"), {
  ssr: false,
  loading: () => <Skeleton height="600px" width="100%" />
});

/**
 * Chooses the grading code viewer based on the per-user `grading.useMonacoEditor` preference (on by
 * default): the new Monaco editor, or the classic plain / starry-night view. A small toggle lets a
 * grader switch and persists the choice immediately.
 */
const CodeFile = forwardRef<CodeFileHandle, CodeFileProps>((props, ref) => {
  const { preferences, updatePreferences, isSaving } = useUserPreferences();
  // Default to the new editor and render it optimistically while preferences load (no skeleton stall).
  const useMonaco = preferences?.grading.useMonacoEditor ?? DEFAULT_USER_PREFERENCES.grading.useMonacoEditor;

  const files = props.files;
  const singleFile = files?.length
    ? (files.find((f) => f.id === (props.activeFileId ?? files[0]?.id)) ?? files[0])
    : props.file;
  const isMultiFileTabs = !!(props.files && props.files.length > 1);

  return (
    <Box w="100%" h="100%" display="flex" flexDirection="column" minH={0}>
      <Flex flexShrink={0} justify="flex-end" px={2} py={1}>
        <Switch
          size="sm"
          checked={useMonaco}
          disabled={isSaving}
          onCheckedChange={({ checked }) => void updatePreferences({ grading: { useMonacoEditor: checked } })}
        >
          New editor view
        </Switch>
      </Flex>
      <Box flex="1" minH={0} w="100%">
        {useMonaco ? (
          <CodeFileMonaco ref={ref} {...props} />
        ) : isMultiFileTabs ? (
          <CodeFilePlain ref={ref} {...props} />
        ) : singleFile ? (
          <CodeFileStarryNight file={singleFile} />
        ) : (
          <CodeFilePlain ref={ref} {...props} />
        )}
      </Box>
    </Box>
  );
});

CodeFile.displayName = "CodeFile";

export default CodeFile;
