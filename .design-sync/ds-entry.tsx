// Design-sync entry barrel. Re-exports ONLY the scoped design-system
// primitives so esbuild bundles just these + their transitive deps (not the
// whole app). `export *` brings each compound component's sub-parts along so
// previews can compose the full thing from window.Pawtograder.*.


// Form & input
export * from "@/components/ui/button";
export * from "@/components/ui/submit-button";
export * from "@/components/ui/checkbox";
export * from "@/components/ui/radio";
export * from "@/components/ui/radio-card";
export * from "@/components/ui/switch";
export * from "@/components/ui/slider";
export * from "@/components/ui/input-group";
export * from "@/components/ui/field";
export * from "@/components/ui/select";

// Data display
export * from "@/components/ui/avatar";
export * from "@/components/ui/alert";
export * from "@/components/ui/skeleton";
export * from "@/components/ui/data-list";

// Overlay
export * from "@/components/ui/dialog";
export * from "@/components/ui/drawer";
export * from "@/components/ui/popover";
export * from "@/components/ui/popconfirm";
export * from "@/components/ui/tooltip";
export * from "@/components/ui/toggle-tip";
export * from "@/components/ui/menu";
export * from "@/components/ui/close-button";

// Misc
export * from "@/components/ui/responsive-table";
export * from "@/components/typography/inline-code";

// ── Wave 2 ────────────────────────────────────────────────────────────────
// Group A — easy widgets (named exports)
export * from "@/components/ui/active-submission-icon";
export * from "@/components/ui/not-graded-submission-icon";
export * from "@/components/ui/decorative-icon";
export * from "@/components/ui/page-container";
export * from "@/components/ui/route-loading-skeleton";
export * from "@/components/ui/due-date-display";
export * from "@/components/ui/term-selector";
export * from "@/components/rubric-editor/DebouncedInput";
// Group A — default exports (export * does not carry defaults)
export { default as NotFound } from "@/components/ui/not-found";
export { default as DownloadLink } from "@/components/ui/download-link";
export { default as GradeAdjustments } from "@/components/grade/GradeAdjustments";
export { default as GradeLedgerHeader } from "@/components/grade/GradeLedgerHeader";
export { default as SurveyFilterButtons } from "@/components/survey/SurveyFilterButtons";

// Group B — markdown + chart
export { default as Markdown } from "@/components/ui/markdown";
export * from "@/components/ui/repo-analytics-chart";

// Group C — rubric editor suite (named exports)
export * from "@/components/rubric-editor/RubricGuiEditor";
export * from "@/components/rubric-editor/RubricEditorTree";
export * from "@/components/rubric-editor/RubricHeaderForm";
export * from "@/components/rubric-editor/PartCard";
export * from "@/components/rubric-editor/CriterionCard";
export * from "@/components/rubric-editor/CheckRow";
export * from "@/components/rubric-editor/SortableList";

// Group D — moderate domain widgets
export * from "@/components/ui/command-palette";
export * from "@/components/survey/AnalyticsConfigEditor";
export * from "@/components/regrade-requests/InstructorRegradeTableShared";
export { default as SurveyBuilder } from "@/components/survey/SurveyBuilder";
export { default as BareCheckResolveLocationFields } from "@/components/regrade-requests/BareCheckResolveLocationFields";

// ── Wave 3 (PARKED): grading interface — rubric-sidebar + code-file-plain.
// The mock data layer in .design-sync/mocks/ + tsconfig.ds.json makes these
// render offline, but their transitive closure bundles to ~14MB (>5MB upload
// limit) and can't be trimmed without forking the bundle step. Re-enable by
// restoring these exports, the componentSrcMap/overrides entries, and
// cfg.tsconfig → ./.design-sync/tsconfig.ds.json. See NOTES.md "Parked: grading".
// export { RubricSidebar } from "@/components/ui/rubric-sidebar";
// export { default as CodeFilePlain } from "@/components/ui/code-file-plain";

// Chakra layout/input primitives used to COMPOSE previews. Re-exported here so
// previews import them from window.Pawtograder (shared Chakra context) rather
// than a freshly-bundled @chakra-ui/react copy (which would break context
// identity → unstyled). NOT carded (absent from componentSrcMap).
export {
  Box,
  Flex,
  Stack,
  HStack,
  VStack,
  Center,
  SimpleGrid,
  Wrap,
  Group,
  Separator,
  Text,
  Heading,
  Span,
  Code,
  Kbd,
  Input,
  Textarea,
  Table,
  Card,
  Badge,
  Spinner,
  Icon,
  IconButton,
  Portal,
  For,
  createListCollection
} from "@chakra-ui/react";

// Preview provider (Chakra system only)
export { PreviewProvider } from "./preview-provider";
