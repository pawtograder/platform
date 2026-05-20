"use client";

import {
  getBareCheckMaterializationKind,
  type BareCheckMaterializationKind,
  type BareCheckResolveLocation
} from "@/lib/regrade/bareCheckMaterialization";
import type { RubricCheck, SubmissionFile, SubmissionArtifact } from "@/utils/supabase/DatabaseTypes";
import { Field, Input, NativeSelectField, NativeSelectRoot, Text, VStack } from "@chakra-ui/react";
import { useMemo } from "react";

function filterFilesForCheck(files: SubmissionFile[], check: RubricCheck): SubmissionFile[] {
  if (!check.file) {
    return files;
  }
  const matched = files.filter((f) => f.name === check.file);
  return matched.length > 0 ? matched : files;
}

function filterArtifactsForCheck(artifacts: SubmissionArtifact[], check: RubricCheck): SubmissionArtifact[] {
  if (!check.artifact) {
    return artifacts;
  }
  const matched = artifacts.filter((a) => a.name === check.artifact);
  return matched.length > 0 ? matched : artifacts;
}

export default function BareCheckResolveLocationFields({
  rubricCheck,
  submissionFiles,
  submissionArtifacts,
  location,
  onChange,
  idPrefix
}: {
  rubricCheck: RubricCheck;
  submissionFiles: SubmissionFile[];
  submissionArtifacts: SubmissionArtifact[];
  location: BareCheckResolveLocation;
  onChange: (location: BareCheckResolveLocation) => void;
  idPrefix: string;
}) {
  const kind = getBareCheckMaterializationKind(rubricCheck);
  const eligibleFiles = useMemo(
    () => filterFilesForCheck(submissionFiles, rubricCheck),
    [submissionFiles, rubricCheck]
  );
  const eligibleArtifacts = useMemo(
    () => filterArtifactsForCheck(submissionArtifacts, rubricCheck),
    [submissionArtifacts, rubricCheck]
  );

  if (kind === "submission") {
    return null;
  }

  return (
    <VStack gap={2} align="start" w="100%">
      <Text fontSize="sm" fontWeight="medium">
        {kind === "file" ? "Annotation location" : "Artifact"}
      </Text>
      <Text fontSize="xs" color="fg.muted">
        {kind === "file"
          ? "This rubric check is a line annotation. Choose the file and line where the grade should appear."
          : "This rubric check applies to a submission artifact. Choose which artifact the grade should appear on."}
      </Text>
      {kind === "file" ? (
        <FileLocationFields idPrefix={idPrefix} files={eligibleFiles} location={location} onChange={onChange} />
      ) : (
        <ArtifactLocationFields
          idPrefix={idPrefix}
          artifacts={eligibleArtifacts}
          location={location}
          onChange={onChange}
        />
      )}
    </VStack>
  );
}

function FileLocationFields({
  files,
  location,
  onChange,
  idPrefix
}: {
  files: SubmissionFile[];
  location: BareCheckResolveLocation;
  onChange: (location: BareCheckResolveLocation) => void;
  idPrefix: string;
}) {
  return (
    <>
      <Field.Root w="100%">
        <Field.Label htmlFor={`${idPrefix}-file`}>File</Field.Label>
        <NativeSelectRoot size="sm">
          <NativeSelectField
            id={`${idPrefix}-file`}
            value={location.submissionFileId?.toString() ?? ""}
            onChange={(e) => {
              const value = e.target.value;
              onChange({
                ...location,
                submissionFileId: value ? Number.parseInt(value, 10) : undefined
              });
            }}
          >
            <option value="">Select a file…</option>
            {files.map((file) => (
              <option key={file.id} value={file.id}>
                {file.name}
              </option>
            ))}
          </NativeSelectField>
        </NativeSelectRoot>
      </Field.Root>
      <Field.Root w="100%">
        <Field.Label htmlFor={`${idPrefix}-line`}>Line number</Field.Label>
        <Input
          id={`${idPrefix}-line`}
          type="number"
          min={1}
          size="sm"
          value={location.line ?? ""}
          onChange={(e) => {
            const raw = e.target.value;
            onChange({
              ...location,
              line: raw === "" ? undefined : Number.parseInt(raw, 10)
            });
          }}
          placeholder="e.g. 42"
        />
      </Field.Root>
    </>
  );
}

function ArtifactLocationFields({
  artifacts,
  location,
  onChange,
  idPrefix
}: {
  artifacts: SubmissionArtifact[];
  location: BareCheckResolveLocation;
  onChange: (location: BareCheckResolveLocation) => void;
  idPrefix: string;
}) {
  return (
    <Field.Root w="100%">
      <Field.Label htmlFor={`${idPrefix}-artifact`}>Artifact</Field.Label>
      <NativeSelectRoot size="sm">
        <NativeSelectField
          id={`${idPrefix}-artifact`}
          value={location.submissionArtifactId?.toString() ?? ""}
          onChange={(e) => {
            const value = e.target.value;
            onChange({
              ...location,
              submissionArtifactId: value ? Number.parseInt(value, 10) : undefined
            });
          }}
        >
          <option value="">Select an artifact…</option>
          {artifacts.map((artifact) => (
            <option key={artifact.id} value={artifact.id}>
              {artifact.name}
            </option>
          ))}
        </NativeSelectField>
      </NativeSelectRoot>
    </Field.Root>
  );
}

export function useDefaultBareCheckResolveLocation(
  kind: BareCheckMaterializationKind,
  rubricCheck: RubricCheck | null | undefined,
  submissionFiles: SubmissionFile[],
  submissionArtifacts: SubmissionArtifact[]
): BareCheckResolveLocation {
  return useMemo(() => {
    if (!rubricCheck || kind === "submission") {
      return {};
    }
    if (kind === "file") {
      const files = filterFilesForCheck(submissionFiles, rubricCheck);
      return {
        submissionFileId: files.length === 1 ? files[0].id : undefined,
        line: undefined
      };
    }
    const artifacts = filterArtifactsForCheck(submissionArtifacts, rubricCheck);
    return {
      submissionArtifactId: artifacts.length === 1 ? artifacts[0].id : undefined
    };
  }, [kind, rubricCheck, submissionFiles, submissionArtifacts]);
}
