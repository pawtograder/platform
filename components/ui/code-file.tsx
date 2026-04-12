"use client";

import { Box, Button, Flex, HStack } from "@chakra-ui/react";
import { Checkbox } from "@/components/ui/checkbox";
import dynamic from "next/dynamic";
import { forwardRef, useCallback, useState } from "react";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { DEFAULT_USER_PREFERENCES } from "@/types/UserPreferences";
import { toaster } from "./toaster";
import { Skeleton } from "./skeleton";
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

const CodeFile = forwardRef<CodeFileHandle, CodeFileProps>((props, ref) => {
  const { preferences, updatePreferences, isSaving } = useUserPreferences();
  const [draftUseMonaco, setDraftUseMonaco] = useState<boolean | null>(null);

  const useMonacoGradingEditor = preferences?.grading.useMonacoEditor;
  const effectiveDraft =
    draftUseMonaco ?? useMonacoGradingEditor ?? DEFAULT_USER_PREFERENCES.grading.useMonacoEditor;

  const handleSavePreference = useCallback(async () => {
    try {
      await updatePreferences({ grading: { useMonacoEditor: effectiveDraft } });
      setDraftUseMonaco(null);
      toaster.success({
        title: "Preference saved",
        description: effectiveDraft
          ? "Monaco editor will load when you view submission code."
          : "Submission code will open in plain text (Monaco will not load)."
      });
    } catch {
      toaster.error({ title: "Could not save preference", description: "Try again in a moment." });
    }
  }, [updatePreferences, effectiveDraft]);

  if (preferences === undefined) {
    return <Skeleton height="620px" width="100%" />;
  }

  const files = props.files;
  const singleFile = files?.length
    ? (files.find((f) => f.id === (props.activeFileId ?? files[0]?.id)) ?? files[0])
    : props.file;

  const isMultiFileTabs = !!(props.files && props.files.length > 1);

  return (
    <Box w="100%">
      <Flex
        mb={2}
        px={2}
        py={2}
        align="center"
        justify="space-between"
        flexWrap="wrap"
        gap={2}
        border="1px solid"
        borderColor="border.emphasized"
        borderRadius="md"
        bg="bg.subtle"
      >
        <HStack gap={3} flexWrap="wrap">
          <Checkbox
            checked={effectiveDraft}
            onCheckedChange={({ checked }) => setDraftUseMonaco(!!checked)}
            fontSize="sm"
          >
            Use new editor view for grading
          </Checkbox>
        </HStack>
        <Button
          size="sm"
          variant="solid"
          colorPalette="blue"
          loading={isSaving}
          onClick={() => void handleSavePreference()}
        >
          Save preference
        </Button>
      </Flex>
      {useMonacoGradingEditor ? (
        <CodeFileMonaco ref={ref} {...props} />
      ) : isMultiFileTabs ? (
        <CodeFilePlain ref={ref} {...props} />
      ) : singleFile ? (
        <CodeFileStarryNight file={singleFile} />
      ) : (
        <CodeFilePlain ref={ref} {...props} />
      )}
    </Box>
  );
});

CodeFile.displayName = "CodeFile";

export default CodeFile;
