"use client";

import { Toaster, toaster } from "@/components/ui/toaster";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useCourseController, useStudentRoster } from "@/hooks/useCourseController";
import { getScore, useGradebookColumns, useGradebookController } from "@/hooks/useGradebook";
import { createClient } from "@/utils/supabase/client";
import { GradebookColumn, UserProfile } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Dialog, HStack, Icon, NativeSelect, Portal, Table, Text, VStack } from "@chakra-ui/react";
import * as Sentry from "@sentry/nextjs";
import { parse } from "csv-parse/browser/esm/sync";
import { useCallback, useEffect, useState } from "react";
import { FiUpload } from "react-icons/fi";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";

type ImportJob = {
  rows: string[][];
  student_identifier_column: number;
  student_identifier_type: "email" | "sid";
  gradebook_columns: {
    name: string;
    idx_in_import: number;
  }[];
  filename: string;
};

type PreviewStudent = {
  identifier: string;
  oldValue: string | number | null;
  newValue: string | number | null;
  fullRow: string[]; // Full CSV row data
};

type PreviewCol = {
  name: string;
  isNew: boolean;
  newColId?: number;
  existingCol: GradebookColumn | null;
  students: PreviewStudent[];
  maxScore?: number;
};

type PreviewData = {
  idType: "email" | "sid";
  idCol: number;
  previewCols: PreviewCol[];
  csvHeaders: string[]; // Full CSV headers for display
};

export default function ImportGradebookColumns() {
  const courseController = useCourseController();
  const { private_profile_id } = useClassProfiles();

  // State for managing collapsed/expanded sections in preview
  const [expandedSections, setExpandedSections] = useState({
    hasChanges: true,
    noChangesInFile: false,
    notInFile: false,
    noRosterMatch: false
  });
  const [importJob, setImportJob] = useState<ImportJob>();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const gradebookController = useGradebookController();
  const existingColumns = useGradebookColumns();
  // State for mapping
  const [studentIdentifierCol, setStudentIdentifierCol] = useState<number | null>(null);
  const [studentIdentifierType, setStudentIdentifierType] = useState<"email" | "sid">("email");
  const [columnMappings, setColumnMappings] = useState<Record<number, number | "new" | "ignore">>({}); // import col idx -> existing col id or 'new'
  const [newColumnMaxScores, setNewColumnMaxScores] = useState<Record<number, number>>({}); // import col idx -> max score for new columns
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const studentRoster = useStudentRoster();
  const [importing, setImporting] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const confirmImport = useCallback(async () => {
    if (!previewData) return;
    setImporting(true);
    const supabase = createClient();
    const existingColumnsNotFromHook = [...gradebookController.gradebook_columns.rows];
    try {
      // 1. For new columns, insert them and get their IDs
      const newCols = previewData.previewCols.filter((col) => col.isNew);
      let sortOrder = existingColumnsNotFromHook.length;
      await Promise.all(
        newCols.map(async (col) => {
          const randomChars = Math.random().toString(36).substring(2, 10);
          const slug =
            col.name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/(^-|-$)/g, "") +
            "-" +
            randomChars;
          const maxScore = col.maxScore ?? 100;

          const insertObj = {
            name: col.name + ` (Imported ${new Date().toLocaleDateString()} #${randomChars})`,
            gradebook_id: gradebookController.gradebook_id,
            class_id: gradebookController.class_id,
            external_data: {
              source: "csv",
              fileName: importJob?.filename,
              date: new Date().toISOString(),
              creator: private_profile_id
            },
            max_score: maxScore,
            description: null,
            dependencies: null,
            slug,
            sort_order: sortOrder++
          };
          const { data, error } = await supabase.from("gradebook_columns").insert(insertObj).select().single();
          if (error) {
            throw new Error(error.message);
          }
          col.newColId = data.id;
        })
      );
      // 1b. For each OLD column that was created by an import, update its expression to refer to the new file
      await Promise.all(
        existingColumnsNotFromHook
          .filter(
            (c) =>
              previewData.previewCols.some((pc) => pc.existingCol?.id === c.id) &&
              c.external_data &&
              typeof c.external_data === "object" &&
              "source" in c.external_data &&
              c.external_data["source"] === "csv"
          )
          .map(async (col) => {
            const { error } = await supabase
              .from("gradebook_columns")
              .update({
                external_data: {
                  source: "csv",
                  fileName: importJob?.filename,
                  date: new Date().toLocaleDateString(),
                  creator: private_profile_id
                }
              })
              .eq("id", col.id);
            if (error) {
              throw new Error(error.message);
            }
            return true;
          })
      );
      // 2. Build a single batched payload and call RPC to update scores server-side
      let preservedGradesCount = 0;
      const updatesPayload = previewData.previewCols
        .map((col) => {
          const colId = col.isNew ? col.newColId : col.existingCol?.id;
          if (!colId) return null;
          const entries = col.students
            .map((s) => {
              let studentPrivateProfileId: string | null = null;
              // Trim identifier for lookup (should already be trimmed, but ensure it)
              const trimmedIdentifier = (s.identifier ?? "").trim();
              if (previewData.idType === "email") {
                // Normalize email for comparison (lowercase, trimmed)
                const normalizedEmail = trimmedIdentifier.toLowerCase();
                studentPrivateProfileId =
                  courseController
                    .getRosterWithUserInfo()
                    .data.find((r) => r.users.email?.trim().toLowerCase() === normalizedEmail)?.private_profile_id ??
                  null;
              } else if (previewData.idType === "sid") {
                const sid = parseInt(trimmedIdentifier, 10);
                if (!isNaN(sid) && isFinite(sid) && sid > 0) {
                  studentPrivateProfileId = courseController.getProfileBySisId(sid)?.id ?? null;
                }
              }
              if (!studentPrivateProfileId) return null;
              // Determine new score - trim before converting
              let newScore: number | null = null;
              const trimmedNewValue = (s.newValue ?? "").toString().trim();
              if (trimmedNewValue !== "" && !isNaN(Number(trimmedNewValue))) {
                newScore = Number(trimmedNewValue);
              }
              // Determine old score (effective)
              let oldScore: number | null = null;
              const trimmedOldValue = (s.oldValue ?? "").toString().trim();
              if (trimmedOldValue !== "" && !isNaN(Number(trimmedOldValue))) {
                oldScore = Number(trimmedOldValue);
              }

              // Preserve existing grades: if student has a grade but no new value in import, skip updating
              if (newScore === null && oldScore !== null) {
                preservedGradesCount++;
                return null; // Skip this update - preserve existing grade
              }

              // Skip no-ops: both null/empty or numerically equal
              const bothNull = newScore === null && oldScore === null;
              const bothEqual = newScore !== null && oldScore !== null && Number(newScore) === Number(oldScore);
              if (bothNull || bothEqual) return null;
              return { student_id: studentPrivateProfileId, score: newScore };
            })
            .filter((e): e is { student_id: string; score: number | null } => e !== null);
          if (entries.length === 0) return null;
          return { gradebook_column_id: colId, entries };
        })
        .filter(
          (
            u
          ): u is {
            gradebook_column_id: number;
            entries: { student_id: string; score: number | null }[];
          } => u !== null
        );

      if (updatesPayload.length > 0) {
        const { error: rpcError } = await supabase.rpc("import_gradebook_scores", {
          p_class_id: gradebookController.class_id,
          p_updates: updatesPayload
        });
        if (rpcError) throw new Error(rpcError.message);
      }

      // Show warning if grades were preserved
      if (preservedGradesCount > 0) {
        toaster.info({
          title: "Some grades preserved",
          description: `${preservedGradesCount} existing grade(s) were preserved because students had no entry in the import for those columns.`
        });
      }

      gradebookController.gradebook_columns.refetchAll();
      toaster.success({
        title: "Import successful!",
        description: "Gradebook columns and scores have been imported."
      });
      setDialogOpen(false);
    } catch (err: unknown) {
      const error = err as Error;
      Sentry.captureException(error);
      toaster.error({
        title: "Import failed",
        description: error.message || "An error occurred during import."
      });
    } finally {
      setImporting(false);
    }
  }, [
    previewData,
    gradebookController.gradebook_id,
    gradebookController.class_id,
    private_profile_id,
    importJob?.filename,
    courseController,
    gradebookController.gradebook_columns
  ]);
  const importFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const csvText = e.target?.result as string;
      const parsedRows: string[][] = parse(csvText, {
        skip_empty_lines: true
      });

      // Trim all values in all cells and filter out rows where all values are blank or just whitespace
      const rows = parsedRows
        .map((row) => row.map((cell) => (cell ?? "").trim()))
        .filter((row) => {
          return row.some((cell) => cell.length > 0);
        });

      setImportJob((prev) => ({
        ...prev,
        rows,
        filename: file.name,
        // The following are placeholders; you may want to set them based on UI/logic
        student_identifier_column: 0,
        student_identifier_type: "email",
        gradebook_columns: []
      }));
    };
    reader.readAsText(file);
  }, []);
  useEffect(() => {
    if (step === 2 && importJob && importJob.rows && importJob.rows[0]) {
      const header = importJob.rows[0];
      const emailIdx = header.findIndex((col) => col.trim().toLowerCase() === "email");
      if (emailIdx !== -1) {
        setStudentIdentifierCol(emailIdx);
      }
    }
    // Only run when step or importJob changes
  }, [step, importJob]);

  // Auto-detect exact matches when entering step 2
  useEffect(() => {
    if (step === 2 && importJob && importJob.rows && importJob.rows[0] && existingColumns.length > 0) {
      const header = importJob.rows[0];
      const currentIdCol = studentIdentifierCol;

      // Auto-detect exact matches between CSV columns and existing gradebook columns
      // Default all columns to "ignore" unless they match
      const autoMappings: Record<number, number | "new" | "ignore"> = {};
      header.forEach((csvColName, idx) => {
        if (idx === currentIdCol) return; // Skip identifier column

        // Try to find exact match (case-insensitive, trimmed)
        const normalizedCsvName = csvColName.trim();
        const exactMatch = existingColumns.find(
          (ec) => ec.name.trim().toLowerCase() === normalizedCsvName.toLowerCase()
        );

        if (exactMatch) {
          autoMappings[idx] = exactMatch.id;
        } else {
          // Default to ignored if no match found
          autoMappings[idx] = "ignore";
        }
      });

      // Only update mappings if current mappings are empty
      // Use a ref-like check by getting current state via a function
      setColumnMappings((currentMappings) => {
        if (Object.keys(currentMappings).length === 0) {
          return autoMappings;
        }
        return currentMappings;
      });
    }
  }, [step, importJob, existingColumns, studentIdentifierCol]);
  return (
    <Dialog.Root
      size={"md"}
      placement={"center"}
      open={dialogOpen}
      onOpenChange={(details) => {
        setDialogOpen(details.open);
        if (!details.open) {
          setImportJob(undefined);
          setStep(1);
          setStudentIdentifierCol(null);
          setStudentIdentifierType("email");
          setColumnMappings({});
          setNewColumnMaxScores({});
          setPreviewData(null);
          setImporting(false);
        }
      }}
    >
      <Dialog.Trigger asChild>
        <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
          <Icon as={FiUpload} mr={2} /> Import Column
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW={"100vw"} maxH={"100vh"} overflow={"auto"} width={"fit-content"}>
            <Dialog.Header>
              <Dialog.Title>Import Gradebook Column</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Toaster />
              <VStack>
                {step === 1 && (
                  <>
                    <Text>Select a CSV file to import gradebook columns.</Text>
                    <input
                      type="file"
                      accept=".csv"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          importFile(file);
                          setStep(2);
                        }
                      }}
                    />
                  </>
                )}
                {step === 2 && importJob && importJob.rows && importJob.rows.length > 0 && (
                  <>
                    <Text>Map columns from your CSV to gradebook columns.</Text>
                    <VStack align="stretch" gap={2}>
                      <Text fontWeight="bold">Select the student identifier column:</Text>
                      <NativeSelect.Root>
                        <NativeSelect.Field
                          value={studentIdentifierCol ?? ""}
                          onChange={(e) => setStudentIdentifierCol(Number(e.target.value))}
                        >
                          <option value="" disabled>
                            Select column
                          </option>
                          {importJob.rows[0].map((col, idx) => (
                            <option key={idx} value={idx}>
                              {col}
                            </option>
                          ))}
                        </NativeSelect.Field>
                      </NativeSelect.Root>
                      <Text fontWeight="bold">Identifier type:</Text>
                      <NativeSelect.Root>
                        <NativeSelect.Field
                          value={studentIdentifierType}
                          onChange={(e) => setStudentIdentifierType(e.target.value as "email" | "sid")}
                        >
                          <option value="email">Email</option>
                          <option value="sid">Student ID</option>
                        </NativeSelect.Field>
                      </NativeSelect.Root>
                      <Text fontWeight="bold" mt={4}>
                        Map grade columns:
                      </Text>
                      <Box p={3} borderRadius="md" bg="bg.muted" borderWidth="1px" borderColor="border.muted" mb={3}>
                        <VStack align="stretch" gap={1} fontSize="sm">
                          <HStack>
                            <Box
                              w="20px"
                              h="20px"
                              borderRadius="sm"
                              borderWidth="2px"
                              borderColor="border.success"
                              bg="bg.success"
                            />
                            <Text>Will update existing column</Text>
                          </HStack>
                          <HStack>
                            <Box
                              w="20px"
                              h="20px"
                              borderRadius="sm"
                              borderWidth="2px"
                              borderColor="border.info"
                              bg="bg.info"
                            />
                            <Text>Will create new column</Text>
                          </HStack>
                          <HStack>
                            <Box
                              w="20px"
                              h="20px"
                              borderRadius="sm"
                              borderWidth="1px"
                              borderStyle="dashed"
                              borderColor="border.warning"
                              bg="bg.warning"
                            />
                            <Text>Unmapped - needs attention</Text>
                          </HStack>
                          <HStack>
                            <Box
                              w="20px"
                              h="20px"
                              borderRadius="sm"
                              borderWidth="1px"
                              borderColor="border.muted"
                              bg="bg.muted"
                              opacity={0.6}
                            />
                            <Text>Will be ignored</Text>
                          </HStack>
                        </VStack>
                      </Box>
                      <VStack align="stretch" gap={2} mt={2}>
                        {importJob.rows[0].map((col, idx) => {
                          if (idx === studentIdentifierCol) return null;

                          const mapping = columnMappings[idx] ?? "ignore";
                          const isMapped = mapping !== "ignore" && mapping !== undefined;
                          const isIgnored = mapping === "ignore";
                          const isNew = mapping === "new";
                          const isExisting = typeof mapping === "number";

                          // Determine visual styling based on mapping status
                          let borderColor = "border.muted";
                          let bgColor = "transparent";
                          const borderStyle = "solid";
                          let borderWidth = "1px";
                          let opacity = 1;

                          if (isMapped && isExisting) {
                            // Mapped to existing column - success
                            borderColor = "border.success";
                            bgColor = "bg.success";
                            borderWidth = "2px";
                          } else if (isNew) {
                            // Creating new column - info
                            borderColor = "border.info";
                            bgColor = "bg.info";
                            borderWidth = "2px";
                          } else if (isIgnored) {
                            // Ignored - muted with strikethrough
                            borderColor = "border.muted";
                            bgColor = "bg.muted";
                            opacity = 0.6;
                          }

                          const matchedColumn = isExisting ? existingColumns.find((ec) => ec.id === mapping) : null;

                          return (
                            <Box
                              key={idx}
                              p={3}
                              borderRadius="md"
                              borderWidth={borderWidth}
                              borderStyle={borderStyle}
                              borderColor={borderColor}
                              bg={bgColor}
                              opacity={opacity}
                            >
                              <VStack align="stretch" gap={1}>
                                <HStack>
                                  <Text
                                    minW="120px"
                                    fontWeight={isMapped ? "semibold" : "normal"}
                                    textDecoration={isIgnored ? "line-through" : "none"}
                                  >
                                    {col}
                                  </Text>
                                  {isMapped && isExisting && matchedColumn && (
                                    <Box
                                      px={2}
                                      py={0.5}
                                      borderRadius="sm"
                                      bg="bg.success"
                                      color="fg.success"
                                      fontSize="xs"
                                      fontWeight="medium"
                                    >
                                      ✓ Auto-matched
                                    </Box>
                                  )}
                                  <NativeSelect.Root>
                                    <NativeSelect.Field
                                      value={mapping ?? "ignore"}
                                      onChange={(e) => {
                                        const newMapping =
                                          e.target.value === "new" || e.target.value === "ignore"
                                            ? e.target.value
                                            : Number(e.target.value);
                                        setColumnMappings((m) => ({
                                          ...m,
                                          [idx]: newMapping
                                        }));
                                        // Set default max score when selecting "new"
                                        if (e.target.value === "new") {
                                          setNewColumnMaxScores((scores) => ({
                                            ...scores,
                                            [idx]: scores[idx] ?? 100
                                          }));
                                        }
                                      }}
                                    >
                                      <option value="ignore">Ignore column</option>
                                      <option value="new">Create new column</option>
                                      {existingColumns.map((ec) => (
                                        <option key={ec.id} value={ec.id}>
                                          {ec.name}
                                        </option>
                                      ))}
                                    </NativeSelect.Field>
                                  </NativeSelect.Root>
                                </HStack>
                                {isMapped && isExisting && matchedColumn && (
                                  <Text fontSize="sm" color="fg.success" ml="120px">
                                    Will update: <strong>{matchedColumn.name}</strong>
                                  </Text>
                                )}
                                {isNew && (
                                  <>
                                    <Text fontSize="sm" color="fg.info" ml="120px">
                                      Will create new column: <strong>{col}</strong>
                                    </Text>
                                    <HStack ml="120px">
                                      <Text fontSize="sm" color="fg.muted" minW="80px">
                                        Max Score:
                                      </Text>
                                      <input
                                        type="number"
                                        value={newColumnMaxScores[idx] ?? 100}
                                        onChange={(e) => {
                                          const value = Number(e.target.value);
                                          setNewColumnMaxScores((scores) => ({
                                            ...scores,
                                            [idx]: value
                                          }));
                                        }}
                                        style={{
                                          width: "80px",
                                          padding: "4px 8px",
                                          border: "1px solid #ccc",
                                          borderRadius: "4px"
                                        }}
                                        min="0"
                                        step="0.01"
                                      />
                                    </HStack>
                                  </>
                                )}
                                {isIgnored && (
                                  <Text fontSize="sm" color="fg.muted" ml="120px" fontStyle="italic">
                                    This column will be ignored
                                  </Text>
                                )}
                              </VStack>
                            </Box>
                          );
                        })}
                      </VStack>
                    </VStack>
                    <HStack mt={4}>
                      <Button onClick={() => setStep(1)} variant="outline" size="sm">
                        Back
                      </Button>
                      <Button
                        colorPalette="green"
                        size="sm"
                        onClick={() => {
                          // Build preview data
                          if (!importJob || !importJob.rows || importJob.rows.length < 2) return;
                          const header = importJob.rows[0];
                          const dataRows = importJob.rows.slice(1);
                          // Build a map of identifier -> row
                          const idCol = studentIdentifierCol ?? 0;
                          const idType = studentIdentifierType;
                          // Build a list of columns to import (excluding ignored and identifier)
                          const importCols = header
                            .map((col, idx) => ({
                              idx,
                              name: col,
                              mapping: columnMappings[idx]
                            }))
                            .filter((c) => c.idx !== idCol && c.mapping !== "ignore");
                          // For each import col, build preview: new/updated, and for each student, old/new value
                          const previewCols = importCols.map((col) => {
                            let existingCol: GradebookColumn | null = null;
                            if (col.mapping !== "new") {
                              existingCol = existingColumns.find((ec) => ec.id === col.mapping) ?? null;
                            } else {
                              col.name = col.name + ` (Imported ${new Date().toLocaleDateString()})`;
                            }
                            // For each student, get identifier and new value
                            const students = dataRows.map((row) => {
                              // Trim identifier and newValue from CSV
                              const identifier = (row[idCol] ?? "").trim();
                              const newValue = (row[col.idx] ?? "").trim();
                              let studentPrivateProfileId: string | null = null;
                              if (idType === "email") {
                                // Normalize email for comparison (lowercase, trimmed)
                                const normalizedEmail = identifier.toLowerCase();
                                studentPrivateProfileId =
                                  courseController
                                    .getRosterWithUserInfo()
                                    .data.find((r) => r.users.email?.trim().toLowerCase() === normalizedEmail)
                                    ?.private_profile_id ?? null;
                              } else if (idType === "sid") {
                                const sid = parseInt(identifier, 10);
                                if (isNaN(sid)) {
                                  studentPrivateProfileId = null;
                                } else {
                                  studentPrivateProfileId = courseController.getProfileBySisId(sid)?.id ?? null;
                                }
                              }
                              let oldValue = null;
                              if (existingCol && studentPrivateProfileId) {
                                const found = gradebookController.getGradebookColumnStudent(
                                  existingCol.id,
                                  studentPrivateProfileId
                                );
                                oldValue = getScore(found) ?? null;
                              }
                              return { identifier, oldValue, newValue, fullRow: row };
                            });
                            return {
                              name: col.name,
                              isNew: col.mapping === "new",
                              existingCol,
                              students,
                              maxScore: col.mapping === "new" ? (newColumnMaxScores[col.idx] ?? 100) : undefined
                            };
                          });
                          setPreviewData({
                            idType,
                            idCol,
                            previewCols,
                            csvHeaders: header
                          });
                          setStep(3);
                        }}
                      >
                        Preview Import
                      </Button>
                    </HStack>
                  </>
                )}
                {step === 3 && previewData && (
                  <>
                    <Text fontWeight="bold" mb={4}>
                      Preview Changes
                    </Text>
                    {/* Filter out ignored columns for preview */}
                    {(() => {
                      const filteredPreviewCols = previewData.previewCols.filter((col) => col.isNew || col.existingCol);
                      const rosterData = courseController.getRosterWithUserInfo().data;
                      const rosterMap = new Map(
                        rosterData.map((rosterEntry) => [rosterEntry.private_profile_id, rosterEntry])
                      );

                      // Helper function to check if a row has changes across all columns
                      const hasChanges = (identifier: string, cols: PreviewCol[], idType: "email" | "sid"): boolean => {
                        return cols.some((col) => {
                          // Normalize identifiers for comparison (emails should be lowercase)
                          const normalizedIdentifier = idType === "email" ? identifier.toLowerCase() : identifier;
                          const student = col.students.find((s) => {
                            const stIdentifier = idType === "email" ? s.identifier.toLowerCase() : s.identifier;
                            return stIdentifier === normalizedIdentifier;
                          });
                          if (!student) return false;
                          if (col.isNew) return true; // New columns always count as changes
                          const normalizedOld = String(student.oldValue ?? "").trim();
                          const normalizedNew = String(student.newValue ?? "").trim();
                          return normalizedOld !== normalizedNew && normalizedNew !== "" && normalizedNew !== null;
                        });
                      };

                      // Build list of all rows with their change status
                      type RowData = {
                        identifier: string;
                        student: PreviewStudent | null;
                        rosterEntry: (typeof rosterData)[0] | null;
                        profile: UserProfile | null;
                        hasChange: boolean;
                        inImport: boolean;
                      };

                      const allRows: RowData[] = [];

                      // Add rows from roster (students in Ptg)
                      studentRoster?.forEach((s) => {
                        const rosterEntry = rosterMap.get(s.id);
                        if (!rosterEntry) return;

                        let identifier: string | null = null;
                        if (previewData.idType === "email") {
                          identifier = rosterEntry.users.email
                            ? String(rosterEntry.users.email).trim().toLowerCase()
                            : null;
                        } else if (previewData.idType === "sid") {
                          identifier =
                            rosterEntry.users.sis_user_id != null ? String(rosterEntry.users.sis_user_id).trim() : null;
                        }

                        if (!identifier) return;

                        // Check if student appears in ANY column (not just the first one)
                        // Normalize identifiers for comparison (emails should be lowercase)
                        const inImport = filteredPreviewCols.some((col) =>
                          col.students.some((st) => {
                            const stIdentifier =
                              previewData.idType === "email" ? st.identifier.toLowerCase() : st.identifier;
                            return stIdentifier === identifier;
                          })
                        );
                        const hasChange = hasChanges(identifier, filteredPreviewCols, previewData.idType);

                        allRows.push({
                          identifier,
                          student: null, // Will look up per column instead
                          rosterEntry,
                          profile: s,
                          hasChange,
                          inImport
                        });
                      });

                      // Add rows from import that aren't in roster
                      const rosterIdentifiers = new Set(
                        studentRoster
                          ?.map((s) => {
                            const rosterEntry = rosterMap.get(s.id);
                            if (!rosterEntry) return null;
                            if (previewData.idType === "email") {
                              return rosterEntry.users.email
                                ? String(rosterEntry.users.email).trim().toLowerCase()
                                : null;
                            } else if (previewData.idType === "sid") {
                              return rosterEntry.users.sis_user_id != null
                                ? String(rosterEntry.users.sis_user_id).trim()
                                : null;
                            }
                            return null;
                          })
                          .filter((id): id is string => !!id) || []
                      );

                      filteredPreviewCols[0]?.students.forEach((student) => {
                        // Normalize identifier for comparison (emails should be lowercase)
                        const normalizedStudentId =
                          previewData.idType === "email" ? student.identifier.toLowerCase() : student.identifier;
                        if (!rosterIdentifiers.has(normalizedStudentId)) {
                          allRows.push({
                            identifier: student.identifier,
                            student,
                            rosterEntry: null,
                            profile: null,
                            hasChange: hasChanges(student.identifier, filteredPreviewCols, previewData.idType),
                            inImport: true
                          });
                        }
                      });

                      // Segment rows into categories
                      const rowsWithChanges = allRows.filter((r) => r.hasChange && r.rosterEntry !== null);
                      const rowsNoChangesInFile = allRows.filter(
                        (r) => !r.hasChange && r.inImport && r.rosterEntry !== null
                      );
                      const rowsNotInFile = allRows.filter(
                        (r) =>
                          !r.inImport &&
                          r.rosterEntry !== null &&
                          !r.rosterEntry.disabled &&
                          r.rosterEntry.role === "student"
                      );
                      const rowsNoRosterMatch = allRows.filter((r) => r.rosterEntry === null);

                      // Sort each category by identifier
                      const sortByIdentifier = (a: RowData, b: RowData) => a.identifier.localeCompare(b.identifier);
                      rowsWithChanges.sort(sortByIdentifier);
                      rowsNoChangesInFile.sort(sortByIdentifier);
                      rowsNotInFile.sort(sortByIdentifier);
                      rowsNoRosterMatch.sort(sortByIdentifier);

                      // Helper to render table rows with consistent column widths
                      const renderTableRows = (rows: RowData[], sectionStartIdx: number) => {
                        return rows.map((rowData, idx) => {
                          const rosterEntry = rowData.rosterEntry;
                          const profile = rowData.profile;
                          const globalIdx = sectionStartIdx + idx;

                          return (
                            <Table.Row
                              key={`${sectionStartIdx}-${idx}`}
                              bg={
                                !rowData.inImport
                                  ? undefined
                                  : rowData.hasChange
                                    ? "bg.warning"
                                    : globalIdx % 2 === 1
                                      ? "bg.subtle"
                                      : undefined
                              }
                            >
                              <Table.Cell style={{ width: identifierColWidth, minWidth: identifierColWidth }}>
                                <Text truncate title={rowData.identifier}>
                                  {rowData.identifier}
                                </Text>
                              </Table.Cell>
                              <Table.Cell style={{ width: nameColWidth, minWidth: nameColWidth }}>
                                <Text truncate title={profile?.name ?? "-"}>
                                  {profile?.name ?? "-"}
                                </Text>
                              </Table.Cell>
                              {previewData.idType === "sid" ? (
                                <Table.Cell style={{ width: emailSidColWidth, minWidth: emailSidColWidth }}>
                                  <Text truncate title={rosterEntry?.users.email ?? "-"}>
                                    {rosterEntry?.users.email ?? "-"}
                                  </Text>
                                </Table.Cell>
                              ) : (
                                <Table.Cell style={{ width: emailSidColWidth, minWidth: emailSidColWidth }}>
                                  <Text
                                    truncate
                                    title={
                                      rosterEntry?.users.sis_user_id != null
                                        ? String(rosterEntry.users.sis_user_id)
                                        : "-"
                                    }
                                  >
                                    {rosterEntry?.users.sis_user_id ?? "-"}
                                  </Text>
                                </Table.Cell>
                              )}
                              {filteredPreviewCols.map((col, colIdx) => {
                                // Look up student data for this specific column
                                // Normalize identifiers for comparison (emails should be lowercase)
                                const normalizedRowId =
                                  previewData.idType === "email"
                                    ? rowData.identifier.toLowerCase()
                                    : rowData.identifier;
                                const s = col.students.find((st) => {
                                  const stIdentifier =
                                    previewData.idType === "email" ? st.identifier.toLowerCase() : st.identifier;
                                  return stIdentifier === normalizedRowId;
                                });
                                if (!s)
                                  return (
                                    <Table.Cell key={colIdx} style={{ width: gradeColWidth, minWidth: gradeColWidth }}>
                                      -
                                    </Table.Cell>
                                  );

                                // Check if this is a preserved grade (has old value but no new value, and not a new column)
                                const hasOldValue =
                                  s.oldValue !== null && s.oldValue !== undefined && String(s.oldValue).trim() !== "";
                                const hasNewValue =
                                  s.newValue !== null && s.newValue !== undefined && String(s.newValue).trim() !== "";
                                const isPreserved = !col.isNew && hasOldValue && !hasNewValue;

                                // For preserved grades (has old value but no new value), show old value like other no-changes
                                if (isPreserved) {
                                  return (
                                    <Table.Cell key={colIdx} style={{ width: gradeColWidth, minWidth: gradeColWidth }}>
                                      {s.oldValue}
                                    </Table.Cell>
                                  );
                                }

                                if (
                                  col.isNew ||
                                  s.oldValue === null ||
                                  s.oldValue === undefined ||
                                  String(s.oldValue).trim() === String(s.newValue).trim()
                                ) {
                                  return (
                                    <Table.Cell key={colIdx} style={{ width: gradeColWidth, minWidth: gradeColWidth }}>
                                      {s.newValue !== null && s.newValue !== undefined && s.newValue !== ""
                                        ? s.newValue
                                        : "-"}
                                    </Table.Cell>
                                  );
                                } else {
                                  return (
                                    <Table.Cell key={colIdx} style={{ width: gradeColWidth, minWidth: gradeColWidth }}>
                                      <s>{s.oldValue}</s>{" "}
                                      <Text as="b" color="fg.success">
                                        {s.newValue !== null && s.newValue !== undefined && s.newValue !== ""
                                          ? s.newValue
                                          : "-"}
                                      </Text>
                                    </Table.Cell>
                                  );
                                }
                              })}
                            </Table.Row>
                          );
                        });
                      };

                      // Track row index across sections for alternating row colors
                      let currentRowIndex = 0;

                      // Define column widths - use fixed widths to prevent email column from expanding
                      const identifierColWidth = "200px";
                      const nameColWidth = "200px";
                      const emailSidColWidth = "150px";
                      const gradeColWidth = "100px";

                      return (
                        <VStack align="stretch" gap={2}>
                          <Box overflowX="auto">
                            <Table.Root width="100%" variant="outline" style={{ tableLayout: "fixed" }}>
                              <Table.Header>
                                <Table.Row>
                                  <Table.ColumnHeader
                                    align="left"
                                    style={{ width: identifierColWidth, minWidth: identifierColWidth }}
                                  >
                                    {previewData.idType === "email" ? "Email" : "Student ID"}
                                  </Table.ColumnHeader>
                                  <Table.ColumnHeader
                                    align="left"
                                    style={{ width: nameColWidth, minWidth: nameColWidth }}
                                  >
                                    Name
                                  </Table.ColumnHeader>
                                  {previewData.idType === "sid" ? (
                                    <Table.ColumnHeader
                                      align="left"
                                      style={{ width: emailSidColWidth, minWidth: emailSidColWidth }}
                                    >
                                      Email
                                    </Table.ColumnHeader>
                                  ) : (
                                    <Table.ColumnHeader
                                      align="left"
                                      style={{ width: emailSidColWidth, minWidth: emailSidColWidth }}
                                    >
                                      Student ID
                                    </Table.ColumnHeader>
                                  )}
                                  {filteredPreviewCols.map((col, colIdx) => (
                                    <Table.ColumnHeader
                                      key={colIdx}
                                      align="left"
                                      style={{ width: gradeColWidth, minWidth: gradeColWidth }}
                                    >
                                      <VStack align="flex-start" gap={1}>
                                        <Text
                                          as="span"
                                          color={col.isNew ? "fg.info" : "fg.success"}
                                          fontWeight="semibold"
                                        >
                                          {col.existingCol ? col.existingCol.name : col.name}
                                        </Text>
                                        {col.existingCol?.score_expression && (
                                          <Text as="span" color="fg.warning" fontSize="xs">
                                            Update will replace any existing score override
                                          </Text>
                                        )}
                                      </VStack>
                                    </Table.ColumnHeader>
                                  ))}
                                </Table.Row>
                              </Table.Header>

                              {/* Section 1: Has changes (always expanded) */}
                              {rowsWithChanges.length > 0 && (
                                <>
                                  <Table.Row
                                    cursor="pointer"
                                    _hover={{ opacity: 0.8 }}
                                    transition="opacity 0.2s"
                                    role="button"
                                    tabIndex={0}
                                    onClick={() =>
                                      setExpandedSections((prev) => ({ ...prev, hasChanges: !prev.hasChanges }))
                                    }
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        setExpandedSections((prev) => ({ ...prev, hasChanges: !prev.hasChanges }));
                                      }
                                    }}
                                    fontWeight="semibold"
                                    color="fg.success"
                                    bg="bg.subtle"
                                    borderTop="2px solid"
                                    borderColor="border.emphasized"
                                  >
                                    <Table.Cell colSpan={3 + filteredPreviewCols.length}>
                                      <HStack>
                                        <Icon as={expandedSections.hasChanges ? LuChevronDown : LuChevronRight} />
                                        <Text>Has changes ({rowsWithChanges.length})</Text>
                                      </HStack>
                                    </Table.Cell>
                                  </Table.Row>
                                  {expandedSections.hasChanges && (
                                    <Table.Body>
                                      {(() => {
                                        const startIdx = currentRowIndex;
                                        currentRowIndex += rowsWithChanges.length;
                                        return renderTableRows(rowsWithChanges, startIdx);
                                      })()}
                                    </Table.Body>
                                  )}
                                </>
                              )}

                              {/* Section 2: No changes to grades from this file, but in the file (collapsed by default) */}
                              {rowsNoChangesInFile.length > 0 && (
                                <>
                                  <Table.Row
                                    cursor="pointer"
                                    _hover={{ opacity: 0.8 }}
                                    transition="opacity 0.2s"
                                    role="button"
                                    tabIndex={0}
                                    onClick={() =>
                                      setExpandedSections((prev) => ({
                                        ...prev,
                                        noChangesInFile: !prev.noChangesInFile
                                      }))
                                    }
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        setExpandedSections((prev) => ({
                                          ...prev,
                                          noChangesInFile: !prev.noChangesInFile
                                        }));
                                      }
                                    }}
                                    fontWeight="semibold"
                                    color="fg.muted"
                                    bg="bg.subtle"
                                    borderTop="2px solid"
                                    borderColor="border.emphasized"
                                  >
                                    <Table.Cell colSpan={3 + filteredPreviewCols.length}>
                                      <HStack>
                                        <Icon as={expandedSections.noChangesInFile ? LuChevronDown : LuChevronRight} />
                                        <Text>
                                          No changes to grades from this file, but in the file (
                                          {rowsNoChangesInFile.length})
                                        </Text>
                                      </HStack>
                                    </Table.Cell>
                                  </Table.Row>
                                  {expandedSections.noChangesInFile && (
                                    <Table.Body>
                                      {(() => {
                                        const startIdx = currentRowIndex;
                                        currentRowIndex += rowsNoChangesInFile.length;
                                        return renderTableRows(rowsNoChangesInFile, startIdx);
                                      })()}
                                    </Table.Body>
                                  )}
                                </>
                              )}

                              {/* Section 3: Not in this file, but in the class (collapsed by default) */}
                              {rowsNotInFile.length > 0 && (
                                <>
                                  <Table.Row
                                    cursor="pointer"
                                    _hover={{ opacity: 0.8 }}
                                    transition="opacity 0.2s"
                                    role="button"
                                    tabIndex={0}
                                    onClick={() =>
                                      setExpandedSections((prev) => ({ ...prev, notInFile: !prev.notInFile }))
                                    }
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        setExpandedSections((prev) => ({ ...prev, notInFile: !prev.notInFile }));
                                      }
                                    }}
                                    fontWeight="semibold"
                                    color="fg.muted"
                                    bg="bg.subtle"
                                    borderTop="2px solid"
                                    borderColor="border.emphasized"
                                  >
                                    <Table.Cell colSpan={3 + filteredPreviewCols.length}>
                                      <HStack>
                                        <Icon as={expandedSections.notInFile ? LuChevronDown : LuChevronRight} />
                                        <Text>Not in this file, but in the class ({rowsNotInFile.length})</Text>
                                      </HStack>
                                    </Table.Cell>
                                  </Table.Row>
                                  {expandedSections.notInFile && (
                                    <Table.Body>
                                      {(() => {
                                        const startIdx = currentRowIndex;
                                        currentRowIndex += rowsNotInFile.length;
                                        return renderTableRows(rowsNotInFile, startIdx);
                                      })()}
                                    </Table.Body>
                                  )}
                                </>
                              )}

                              {/* Section 4: In the import file but didn&apos;t match to the roster (collapsed by default) */}
                              {rowsNoRosterMatch.length > 0 && (
                                <>
                                  <Table.Row
                                    cursor="pointer"
                                    _hover={{ opacity: 0.8 }}
                                    transition="opacity 0.2s"
                                    role="button"
                                    tabIndex={0}
                                    onClick={() =>
                                      setExpandedSections((prev) => ({ ...prev, noRosterMatch: !prev.noRosterMatch }))
                                    }
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        setExpandedSections((prev) => ({
                                          ...prev,
                                          noRosterMatch: !prev.noRosterMatch
                                        }));
                                      }
                                    }}
                                    fontWeight="semibold"
                                    color="fg.warning"
                                    bg="bg.subtle"
                                    borderTop="2px solid"
                                    borderColor="border.emphasized"
                                  >
                                    <Table.Cell colSpan={3 + filteredPreviewCols.length}>
                                      <HStack>
                                        <Icon as={expandedSections.noRosterMatch ? LuChevronDown : LuChevronRight} />
                                        <Text>
                                          In the import file but didn&apos;t match to the roster (
                                          {rowsNoRosterMatch.length})
                                        </Text>
                                      </HStack>
                                    </Table.Cell>
                                  </Table.Row>
                                  {expandedSections.noRosterMatch && (
                                    <Table.Body>
                                      {(() => {
                                        const startIdx = currentRowIndex;
                                        currentRowIndex += rowsNoRosterMatch.length;
                                        return renderTableRows(rowsNoRosterMatch, startIdx);
                                      })()}
                                    </Table.Body>
                                  )}
                                </>
                              )}
                            </Table.Root>
                          </Box>
                        </VStack>
                      );
                    })()}
                    <HStack mt={4}>
                      <Button onClick={() => setStep(2)} variant="outline" size="sm">
                        Back
                      </Button>
                      <Button colorPalette="green" size="sm" loading={importing} onClick={confirmImport}>
                        Confirm Import
                      </Button>
                    </HStack>
                  </>
                )}
              </VStack>
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
