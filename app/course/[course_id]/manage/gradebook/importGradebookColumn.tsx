"use client";

import { Alert } from "@/components/ui/alert";
import { Toaster, toaster } from "@/components/ui/toaster";
import { useClassProfiles, useStudentRoster } from "@/hooks/useClassProfiles";
import { useCourseController } from "@/hooks/useCourseController";
import { getScore, useGradebookColumns, useGradebookController } from "@/hooks/useGradebook";
import { createClient } from "@/utils/supabase/client";
import { GradebookColumn, GradebookColumnStudent } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Dialog, HStack, Icon, NativeSelect, Portal, Table, Text, VStack } from "@chakra-ui/react";
import { useInvalidate } from "@refinedev/core";
import { parse } from "csv-parse/browser/esm/sync";
import { useCallback, useEffect, useState } from "react";
import { FiUpload } from "react-icons/fi";
import { MdWarning } from "react-icons/md";

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
};

type PreviewCol = {
  name: string;
  isNew: boolean;
  newColId?: number;
  newGradebookColumnStudents?: GradebookColumnStudent[];
  existingCol: GradebookColumn | null;
  students: PreviewStudent[];
  maxScore?: number;
};

type PreviewData = {
  idType: "email" | "sid";
  idCol: number;
  previewCols: PreviewCol[];
};

export default function ImportGradebookColumns() {
  const courseController = useCourseController();
  const { private_profile_id } = useClassProfiles();
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
  const invalidate = useInvalidate();
  const importFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const csvText = e.target?.result as string;
      const rows: string[][] = parse(csvText, {
        skip_empty_lines: true
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
                      {importJob.rows[0].map((col, idx) =>
                        idx === studentIdentifierCol ? null : (
                          <VStack key={idx} align="stretch" gap={1}>
                            <HStack>
                              <Text minW="120px">{col}</Text>
                              <NativeSelect.Root>
                                <NativeSelect.Field
                                  value={columnMappings[idx] ?? ""}
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
                            {columnMappings[idx] === "new" && (
                              <HStack ml="120px">
                                <Text fontSize="sm" color="gray.600" minW="80px">
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
                            )}
                          </VStack>
                        )
                      )}
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
                              const identifier = row[idCol];
                              const newValue = row[col.idx];
                              let studentPrivateProfileId: string | null = null;
                              if (idType === "email") {
                                studentPrivateProfileId =
                                  courseController
                                    .getRosterWithUserInfo()
                                    .data.find((r) => r.users.email === identifier)?.private_profile_id ?? null;
                              } else if (idType === "sid") {
                                const sid = (identifier ?? "").toString();
                                studentPrivateProfileId = courseController.getProfileBySisId(sid)?.id ?? null;
                              }
                              let oldValue = null;
                              if (existingCol && studentPrivateProfileId) {
                                const found = gradebookController.gradebook_column_students.rows.find(
                                  (s) =>
                                    s.gradebook_column_id === existingCol.id && s.student_id === studentPrivateProfileId
                                );
                                oldValue = getScore(found) ?? null;
                              }
                              return { identifier, oldValue, newValue };
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
                            previewCols
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
                    {/* Error reporting */}
                    {(() => {
                      let importIdentifiers = previewData.previewCols[0]?.students.map((s) => s.identifier) || [];
                      importIdentifiers = importIdentifiers.filter((id): id is string => !!id);
                      const rosterIdentifiers = studentRoster
                        .map((s) => {
                          if (previewData.idType === "email") {
                            const rosterEntry = courseController
                              .getRosterWithUserInfo()
                              .data.find((r) => r.private_profile_id === s.id);
                            return rosterEntry?.users.email ?? null;
                          } else if (previewData.idType === "sid") {
                            return s.sis_user_id;
                          }
                          return null;
                        })
                        .filter((id): id is string => !!id);
                      const notInRoster = importIdentifiers.filter((id) => !rosterIdentifiers.includes(id));
                      const notInImport = rosterIdentifiers.filter((id) => !importIdentifiers.includes(id));
                      return (
                        <VStack mb={2} align="stretch">
                          {notInRoster.length > 0 && (
                            <Alert status="warning" variant="subtle">
                              Warning: {notInRoster.length} student(s) in the import are not in the roster. These
                              students will not be imported. {notInRoster.join(", ")}
                            </Alert>
                          )}
                          {notInImport.length > 0 && (
                            <Alert status="info" variant="subtle">
                              Note: {notInImport.length} student(s) in the roster are not in the import. These students
                              will receive a &quot;missing&quot; grade for the imported columns.
                              {notInImport.join(", ")}
                            </Alert>
                          )}
                        </VStack>
                      );
                    })()}
                    <Text fontWeight="bold" mb={2}>
                      Preview Changes
                    </Text>
                    {/* Filter out ignored columns for preview */}
                    {(() => {
                      const filteredPreviewCols = previewData.previewCols.filter((col) => col.isNew || col.existingCol);
                      return (
                        <Table.Root width="100%" variant="outline">
                          <Table.Header>
                            <Table.Row>
                              <Table.ColumnHeader align="left">
                                {previewData.idType === "email" ? "Email" : "Student ID"}
                              </Table.ColumnHeader>
                              {filteredPreviewCols.map((col, colIdx) => (
                                <Table.ColumnHeader key={colIdx} align="left">
                                  <span style={{ color: col.isNew ? "green" : "blue" }}>
                                    {col.existingCol ? `Update: ${col.existingCol.name}` : `New: ${col.name}`}
                                  </span>
                                  {col.existingCol?.score_expression && (
                                    <Box
                                      color="fg.warning"
                                      fontSize="md"
                                      maxW="300px"
                                      border="1px solid"
                                      borderColor="fg.warning"
                                      borderRadius="md"
                                      p={1}
                                      mt={1}
                                      bg="bg.warning"
                                    >
                                      <Icon as={MdWarning} />
                                      Update will override calculated score. Only do this if you really are sure you
                                      want to do this!
                                    </Box>
                                  )}
                                </Table.ColumnHeader>
                              ))}
                            </Table.Row>
                          </Table.Header>
                          <Table.Body>
                            {studentRoster.map((student, idx) => {
                              let identifier: string | null = null;
                              if (previewData.idType === "email") {
                                const rosterEntry = courseController
                                  .getRosterWithUserInfo()
                                  .data.find((r) => r.private_profile_id === student.id);
                                identifier = rosterEntry?.users.email ?? null;
                              } else if (previewData.idType === "sid") {
                                identifier = student.sis_user_id;
                              }
                              if (!identifier) return null;
                              const importIdx = filteredPreviewCols[0]?.students.findIndex(
                                (s) => s.identifier === identifier
                              );
                              const inImport = importIdx !== -1 && importIdx !== undefined;
                              return (
                                <Table.Row
                                  key={idx}
                                  bg={inImport ? (idx % 2 === 1 ? "bg.subtle" : undefined) : undefined}
                                >
                                  <Table.Cell>{identifier}</Table.Cell>
                                  {filteredPreviewCols.map((col, colIdx) => {
                                    const s = inImport ? col.students[importIdx] : undefined;
                                    if (!s) return <Table.Cell key={colIdx}>-</Table.Cell>;
                                    if (
                                      col.isNew ||
                                      s.oldValue === null ||
                                      s.oldValue === undefined ||
                                      String(s.oldValue).trim() === String(s.newValue).trim()
                                    ) {
                                      return (
                                        <Table.Cell key={colIdx}>
                                          {s.newValue !== null && s.newValue !== undefined && s.newValue !== ""
                                            ? s.newValue
                                            : "-"}
                                        </Table.Cell>
                                      );
                                    } else {
                                      return (
                                        <Table.Cell key={colIdx}>
                                          <s>{s.oldValue}</s>{" "}
                                          <b style={{ color: "green" }}>
                                            {s.newValue !== null && s.newValue !== undefined && s.newValue !== ""
                                              ? s.newValue
                                              : "-"}
                                          </b>
                                        </Table.Cell>
                                      );
                                    }
                                  })}
                                </Table.Row>
                              );
                            })}
                            {/* Highlight students in the import not in the roster */}
                            {(() => {
                              let importIdentifiers = filteredPreviewCols[0]?.students.map((s) => s.identifier) || [];
                              importIdentifiers = importIdentifiers.filter((id): id is string => !!id);
                              const rosterIdentifiers = studentRoster
                                .map((s) => {
                                  if (previewData.idType === "email") {
                                    const rosterEntry = courseController
                                      .getRosterWithUserInfo()
                                      .data.find((r) => r.private_profile_id === s.id);
                                    return rosterEntry?.users.email ?? null;
                                  } else if (previewData.idType === "sid") {
                                    return s.sis_user_id;
                                  }
                                  return null;
                                })
                                .filter((id): id is string => !!id);
                              return importIdentifiers
                                .filter((id) => !rosterIdentifiers.includes(id))
                                .map((identifier, idx) => (
                                  <Table.Row key={"import-missing-" + idx} bg="bg.warning">
                                    <Table.Cell>{identifier}</Table.Cell>
                                    {filteredPreviewCols.map((col, colIdx) => {
                                      const s = col.students.find((s) => s.identifier === identifier);
                                      if (!s) return <Table.Cell key={colIdx}>-</Table.Cell>;
                                      if (
                                        col.isNew ||
                                        s.oldValue === null ||
                                        s.oldValue === undefined ||
                                        String(s.oldValue).trim() === String(s.newValue).trim()
                                      ) {
                                        return (
                                          <Table.Cell key={colIdx}>
                                            {s.newValue !== null && s.newValue !== undefined && s.newValue !== ""
                                              ? s.newValue
                                              : "-"}
                                          </Table.Cell>
                                        );
                                      } else {
                                        return (
                                          <Table.Cell key={colIdx}>
                                            <s>{s.oldValue}</s>{" "}
                                            <b style={{ color: "green" }}>
                                              {s.newValue !== null && s.newValue !== undefined && s.newValue !== ""
                                                ? s.newValue
                                                : "-"}
                                            </b>
                                          </Table.Cell>
                                        );
                                      }
                                    })}
                                  </Table.Row>
                                ));
                            })()}
                          </Table.Body>
                        </Table.Root>
                      );
                    })()}
                    <HStack mt={4}>
                      <Button onClick={() => setStep(2)} variant="outline" size="sm">
                        Back
                      </Button>
                      <Button
                        colorPalette="green"
                        size="sm"
                        loading={importing}
                        onClick={async () => {
                          if (!previewData) return;
                          setImporting(true);
                          const supabase = createClient();
                          try {
                            // 1. For new columns, insert them and get their IDs
                            const newCols = previewData.previewCols.filter((col) => col.isNew);
                            let sortOrder = existingColumns.length;
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
                                    date: new Date().toLocaleDateString(),
                                    creator: private_profile_id
                                  },
                                  max_score: maxScore,
                                  description: null,
                                  dependencies: null,
                                  slug,
                                  sort_order: sortOrder++
                                };
                                const { data, error } = await supabase
                                  .from("gradebook_columns")
                                  .insert(insertObj)
                                  .select()
                                  .single();
                                if (error) {
                                  throw new Error(error.message);
                                }
                                col.newColId = data.id;
                                const { data: newGradebookColumnStudents, error: newGradebookColumnStudentsError } =
                                  await supabase
                                    .from("gradebook_column_students")
                                    .select("*")
                                    .eq("gradebook_column_id", data.id)
                                    .eq("is_private", true);
                                if (newGradebookColumnStudentsError) {
                                  throw new Error(newGradebookColumnStudentsError.message);
                                }
                                col.newGradebookColumnStudents = newGradebookColumnStudents;
                              })
                            );
                            // 1b. For each OLD column that was created by an import, update its expression to refer to the new file
                            await Promise.all(
                              existingColumns
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
                            // 2. For each column, update all student scores
                            await Promise.all(
                              previewData.previewCols.map(async (col) => {
                                const colId = col.isNew ? col.newColId : col.existingCol?.id;
                                if (!colId) return null;
                                // Only update for students in the roster
                                const studentsToUpdate = col.students.filter((s) => {
                                  if (previewData.idType === "email") {
                                    return courseController
                                      .getRosterWithUserInfo()
                                      .data.some((r) => r.users.email === s.identifier);
                                  } else if (previewData.idType === "sid") {
                                    return courseController.getProfileBySisId(s.identifier)?.id !== null;
                                  }
                                  return false;
                                });
                                // Build update payloads by finding the existing gradebook_column_students row
                                const updateRows = studentsToUpdate
                                  .map((s) => {
                                    let studentPrivateProfileId: string | null = null;
                                    if (previewData.idType === "email") {
                                      studentPrivateProfileId =
                                        courseController
                                          .getRosterWithUserInfo()
                                          .data.find((r) => r.users.email === s.identifier)?.private_profile_id ?? null;
                                    } else if (previewData.idType === "sid") {
                                      const sid = (s.identifier ?? "").toString();
                                      studentPrivateProfileId = courseController.getProfileBySisId(sid)?.id ?? null;
                                    }
                                    if (!studentPrivateProfileId) return null;
                                    // Find the gradebook_column_students row for this student/column
                                    const column = gradebookController.gradebook_columns.rows.find(
                                      (c) => c.id === colId
                                    );
                                    const gcs = col.isNew
                                      ? col.newGradebookColumnStudents?.find(
                                          (g) => g.student_id === studentPrivateProfileId && g.is_private
                                        )
                                      : gradebookController.gradebook_column_students.rows.find(
                                          (g) => g.student_id === studentPrivateProfileId && g.is_private
                                        );
                                    if (!gcs) return null;
                                    let score: number | undefined = undefined;
                                    if (
                                      s.newValue !== "" &&
                                      s.newValue !== null &&
                                      s.newValue !== undefined &&
                                      !isNaN(Number(s.newValue))
                                    ) {
                                      score = Number(s.newValue);
                                    }
                                    let updateObj: {
                                      id: number;
                                      update: { score?: number; score_override?: number };
                                    } | null = null;
                                    if (column?.score_expression) {
                                      // Only update score_override
                                      updateObj = {
                                        id: gcs.id,
                                        update: { score_override: score }
                                      };
                                    } else {
                                      // Update score, clear any overrides
                                      updateObj = {
                                        id: gcs.id,
                                        update: { score: score }
                                      };
                                    }
                                    return updateObj;
                                  })
                                  .filter(
                                    (r): r is { id: number; update: { score?: number; score_override?: number } } =>
                                      r !== null
                                  );
                                if (updateRows.length === 0) return null;
                                await Promise.all(
                                  updateRows.map(async (row) => {
                                    const { error } = await supabase
                                      .from("gradebook_column_students")
                                      .update(row.update)
                                      .eq("id", row.id);
                                    if (error) throw new Error(error.message);
                                  })
                                );
                                return true;
                              })
                            );
                            invalidate({ resource: "gradebook_columns", invalidates: ["all"] });
                            toaster.success({
                              title: "Import successful!",
                              description: "Gradebook columns and scores have been imported."
                            });
                            setDialogOpen(false);
                          } catch (err: unknown) {
                            const error = err as Error;
                            toaster.error({
                              title: "Import failed",
                              description: error.message || "An error occurred during import."
                            });
                          } finally {
                            setImporting(false);
                          }
                        }}
                      >
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
