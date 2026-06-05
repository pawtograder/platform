"use client";

import { Box } from "@chakra-ui/react";
import dynamic from "next/dynamic";
import { forwardRef } from "react";
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

// The Monaco-based editor is the only grading view — the legacy plain / starry-night
// variants and the per-user "use new editor" preference toggle have been retired.
const CodeFile = forwardRef<CodeFileHandle, CodeFileProps>((props, ref) => {
  return (
    <Box w="100%" h="100%" display="flex" flexDirection="column" minH={0}>
      <Box flex="1" minH={0} w="100%">
        <CodeFileMonaco ref={ref} {...props} />
      </Box>
    </Box>
  );
});

CodeFile.displayName = "CodeFile";

export default CodeFile;
