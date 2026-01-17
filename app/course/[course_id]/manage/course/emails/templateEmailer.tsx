"use client";

import { Button } from "@/components/ui/button";
import { toaster } from "@/components/ui/toaster";
import MdEditor from "@/components/ui/md-editor";
import { createClient } from "@/utils/supabase/client";
import { Assignment, Course, LabSection } from "@/utils/supabase/DatabaseTypes";
import {
  Box,
  Card,
  Field,
  Flex,
  Heading,
  HStack,
  Input,
  Spinner,
  Table,
  Text,
  VStack,
  Badge,
  Icon,
  Accordion,
  Separator
} from "@chakra-ui/react";
import { Select } from "chakra-react-select";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LuMail, LuUsers, LuFileText, LuCode, LuEye, LuSend, LuRefreshCw } from "react-icons/lu";
import { useEmailManagement, EmailCreateDataWithoutId } from "./EmailManagementContext";
import { useOne, useList } from "@refinedev/core";

type EmailTemplate = {
  id: number;
  name: string;
  description: string | null;
  subject_template: string;
  body_template: string;
  rpc_function_name: string;
  rpc_description: string | null;
  available_variables: string[];
  variable_descriptions: Record<string, string>;
  is_active: boolean;
  requires_assignment: boolean;
  requires_lab_section: boolean;
  scope: string;
};

type RecipientRow = {
  user_id: string;
  email: string;
  private_profile_id: string;
  [key: string]: unknown;
};

// RPC parameter configurations for different functions
const RPC_PARAMETER_CONFIGS: Record<
  string,
  {
    name: string;
    type: "number" | "boolean" | "text";
    label: string;
    defaultValue?: unknown;
  }[]
> = {
  emailer_get_students_with_test_errors: [
    { name: "p_test_name_pattern", type: "text", label: "Test Name Pattern (regex)" },
    { name: "p_min_score", type: "number", label: "Minimum Score" },
    { name: "p_max_score", type: "number", label: "Maximum Score" }
  ],
  emailer_get_students_with_failing_tests: [
    { name: "p_include_zero_scores", type: "boolean", label: "Include Zero Scores", defaultValue: true },
    { name: "p_include_error_tests", type: "boolean", label: "Include Error Tests", defaultValue: true }
  ],
  emailer_get_lab_leaders_with_missing_grades: [],
  emailer_get_students_without_submissions: [],
  emailer_get_students_with_low_scores: [
    { name: "p_max_score_threshold", type: "number", label: "Max Score Threshold", defaultValue: 50 }
  ]
};

export default function TemplateEmailer() {
  const { course_id } = useParams();
  const supabase = useMemo(() => createClient(), []);
  const { addEmails, addBatch } = useEmailManagement();

  // State
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate | null>(null);
  const [selectedAssignment, setSelectedAssignment] = useState<Assignment | null>(null);
  const [selectedLabSection, setSelectedLabSection] = useState<LabSection | null>(null);
  const [rpcParams, setRpcParams] = useState<Record<string, unknown>>({});
  const [recipients, setRecipients] = useState<RecipientRow[]>([]);
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(true);
  const [isLoadingRecipients, setIsLoadingRecipients] = useState(false);
  const [subjectLine, setSubjectLine] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [replyEmail, setReplyEmail] = useState("");

  // Fetch course data
  const { data: courseData } = useOne<Course>({
    resource: "classes",
    id: course_id as string,
    queryOptions: { enabled: !!course_id }
  });
  const course = courseData?.data;

  // Fetch assignments
  const { data: assignmentsData } = useList<Assignment>({
    resource: "assignments",
    filters: [{ field: "class_id", operator: "eq", value: course_id }],
    pagination: { pageSize: 1000 }
  });

  // Fetch lab sections
  const { data: labSectionsData } = useList<LabSection>({
    resource: "lab_sections",
    filters: [{ field: "class_id", operator: "eq", value: course_id }],
    queryOptions: { enabled: !!course_id }
  });

  // Fetch templates
  const fetchTemplates = useCallback(async () => {
    setIsLoadingTemplates(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from("email_templates")
        .select("*")
        .eq("is_active", true)
        .or(`scope.eq.global,and(scope.eq.course,class_id.eq.${course_id})`)
        .order("name");

      if (error) throw error;
      setTemplates((data as EmailTemplate[]) || []);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Error fetching templates:", error);
      toaster.error({
        title: "Error loading templates",
        description: error instanceof Error ? error.message : "Unknown error"
      });
    } finally {
      setIsLoadingTemplates(false);
    }
  }, [supabase, course_id]);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  // Update form when template is selected
  useEffect(() => {
    if (selectedTemplate) {
      setSubjectLine(selectedTemplate.subject_template);
      setBodyText(selectedTemplate.body_template);

      // Initialize RPC params with defaults
      const paramConfig = RPC_PARAMETER_CONFIGS[selectedTemplate.rpc_function_name] || [];
      const defaults: Record<string, unknown> = {};
      paramConfig.forEach((p) => {
        if (p.defaultValue !== undefined) {
          defaults[p.name] = p.defaultValue;
        }
      });
      setRpcParams(defaults);

      // Clear recipients when template changes
      setRecipients([]);
    }
  }, [selectedTemplate]);

  // Fetch recipients from RPC
  const fetchRecipients = useCallback(async () => {
    if (!selectedTemplate) return;

    // Check requirements
    if (selectedTemplate.requires_assignment && !selectedAssignment) {
      toaster.error({ title: "Please select an assignment" });
      return;
    }

    setIsLoadingRecipients(true);
    try {
      const params: Record<string, unknown> = {
        p_class_id: Number(course_id)
      };

      // Add assignment_id if required
      if (selectedTemplate.requires_assignment && selectedAssignment) {
        params.p_assignment_id = selectedAssignment.id;
      }

      // Add lab section if required
      if (selectedTemplate.requires_lab_section && selectedLabSection) {
        params.p_lab_section_id = selectedLabSection.id;
      }

      // Add custom RPC params
      Object.entries(rpcParams).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") {
          params[key] = value;
        }
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc(
        selectedTemplate.rpc_function_name,
        params
      );

      if (error) throw error;

      // Deduplicate by user_id
      const uniqueRecipients = Array.from(
        new Map((data || []).map((r: RecipientRow) => [r.user_id, r])).values()
      ) as RecipientRow[];

      setRecipients(uniqueRecipients);
      toaster.success({
        title: `Found ${uniqueRecipients.length} recipient(s)`
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Error fetching recipients:", error);
      toaster.error({
        title: "Error fetching recipients",
        description: error instanceof Error ? error.message : "Unknown error"
      });
      setRecipients([]);
    } finally {
      setIsLoadingRecipients(false);
    }
  }, [selectedTemplate, selectedAssignment, selectedLabSection, rpcParams, course_id, supabase]);

  // Replace template variables
  const replaceVariables = useCallback(
    (text: string, recipient: RecipientRow): string => {
      let result = text;

      // Replace course_name
      if (course?.name) {
        result = result.replace(/{course_name}/g, course.name);
      }

      // Replace all other variables from recipient data
      Object.entries(recipient).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
          const regex = new RegExp(`{${key}}`, "g");
          result = result.replace(regex, String(value));
        }
      });

      return result;
    },
    [course]
  );

  // Add emails to preview
  const handleAddToPreview = useCallback(() => {
    if (recipients.length === 0) {
      toaster.error({ title: "No recipients to email" });
      return;
    }

    if (!subjectLine || !bodyText) {
      toaster.error({ title: "Please enter subject and body" });
      return;
    }

    const batch = addBatch({
      subject: subjectLine,
      body: bodyText,
      assignment_id: selectedAssignment?.id,
      cc_ids: [],
      reply_to: replyEmail || ""
    });

    const formattedEmails: EmailCreateDataWithoutId[] = recipients.map((recipient) => ({
      batch_id: batch.id,
      to: { email: recipient.email, user_id: recipient.user_id },
      why: (
        <>
          Template: {selectedTemplate?.name}
          {selectedAssignment && <> - {selectedAssignment.title}</>}
        </>
      ),
      subject: replaceVariables(subjectLine, recipient),
      body: replaceVariables(bodyText, recipient),
      cc_ids: [],
      reply_to: replyEmail || ""
    }));

    addEmails(formattedEmails);
    toaster.success({
      title: `Added ${formattedEmails.length} email(s) to preview`
    });
  }, [
    recipients,
    subjectLine,
    bodyText,
    replyEmail,
    selectedTemplate,
    selectedAssignment,
    addBatch,
    addEmails,
    replaceVariables
  ]);

  // Get parameter config for current template
  const paramConfig = selectedTemplate
    ? RPC_PARAMETER_CONFIGS[selectedTemplate.rpc_function_name] || []
    : [];

  return (
    <VStack align="stretch" gap={6}>
      {/* Header */}
      <Box>
        <HStack gap={2} mb={2}>
          <Icon color="blue.500">
            <LuFileText size={24} />
          </Icon>
          <Heading size="lg">Template-Based Emailer</Heading>
        </HStack>
        <Text color="fg.muted" fontSize="sm">
          Use pre-defined templates to email specific groups of students or staff based on dynamic
          queries.
        </Text>
      </Box>

      {/* Template Selection */}
      <Card.Root>
        <Card.Header>
          <HStack gap={2}>
            <Icon>
              <LuFileText size={18} />
            </Icon>
            <Card.Title>1. Select Template</Card.Title>
          </HStack>
        </Card.Header>
        <Card.Body>
          {isLoadingTemplates ? (
            <Flex justify="center" py={4}>
              <Spinner />
            </Flex>
          ) : (
            <VStack align="stretch" gap={4}>
              <Field.Root>
                <Field.Label>Email Template</Field.Label>
                <Select
                  value={
                    selectedTemplate
                      ? { label: selectedTemplate.name, value: selectedTemplate.id }
                      : null
                  }
                  onChange={(option) => {
                    const template = templates.find((t) => t.id === option?.value);
                    setSelectedTemplate(template || null);
                    setRecipients([]);
                  }}
                  options={templates.map((t) => ({
                    label: t.name,
                    value: t.id
                  }))}
                  placeholder="Select a template..."
                />
              </Field.Root>

              {selectedTemplate && (
                <Box p={3} bg="bg.subtle" borderRadius="md">
                  <Text fontSize="sm" color="fg.muted" mb={2}>
                    {selectedTemplate.description || selectedTemplate.rpc_description}
                  </Text>
                  <HStack gap={2} flexWrap="wrap">
                    {selectedTemplate.requires_assignment && (
                      <Badge colorPalette="purple">Requires Assignment</Badge>
                    )}
                    {selectedTemplate.requires_lab_section && (
                      <Badge colorPalette="green">Requires Lab Section</Badge>
                    )}
                  </HStack>
                </Box>
              )}
            </VStack>
          )}
        </Card.Body>
      </Card.Root>

      {/* Configuration (Assignment/Lab Section selection) */}
      {selectedTemplate && (selectedTemplate.requires_assignment || selectedTemplate.requires_lab_section) && (
        <Card.Root>
          <Card.Header>
            <HStack gap={2}>
              <Icon>
                <LuCode size={18} />
              </Icon>
              <Card.Title>2. Configure Query</Card.Title>
            </HStack>
          </Card.Header>
          <Card.Body>
            <VStack align="stretch" gap={4}>
              {selectedTemplate.requires_assignment && (
                <Field.Root required>
                  <Field.Label>Assignment</Field.Label>
                  <Select
                    value={
                      selectedAssignment
                        ? { label: selectedAssignment.title, value: selectedAssignment.id }
                        : null
                    }
                    onChange={(option) => {
                      const assignment = assignmentsData?.data.find((a) => a.id === option?.value);
                      setSelectedAssignment(assignment || null);
                      setRecipients([]);
                    }}
                    options={assignmentsData?.data.map((a) => ({
                      label: a.title,
                      value: a.id
                    }))}
                    placeholder="Select an assignment..."
                  />
                </Field.Root>
              )}

              {selectedTemplate.requires_lab_section && (
                <Field.Root>
                  <Field.Label>Lab Section (optional filter)</Field.Label>
                  <Select
                    value={
                      selectedLabSection
                        ? { label: selectedLabSection.name, value: selectedLabSection.id }
                        : null
                    }
                    onChange={(option) => {
                      const section = labSectionsData?.data.find((s) => s.id === option?.value);
                      setSelectedLabSection(section || null);
                      setRecipients([]);
                    }}
                    options={labSectionsData?.data.map((s) => ({
                      label: s.name,
                      value: s.id
                    }))}
                    placeholder="All lab sections..."
                    isClearable
                  />
                </Field.Root>
              )}

              {/* Custom RPC Parameters */}
              {paramConfig.length > 0 && (
                <>
                  <Separator />
                  <Text fontWeight="medium" fontSize="sm">
                    Additional Filters
                  </Text>
                  {paramConfig.map((param) => (
                    <Field.Root key={param.name}>
                      <Field.Label>{param.label}</Field.Label>
                      {param.type === "boolean" ? (
                        <Select
                          value={
                            rpcParams[param.name] !== undefined
                              ? {
                                  label: rpcParams[param.name] ? "Yes" : "No",
                                  value: rpcParams[param.name] as boolean
                                }
                              : null
                          }
                          onChange={(option) => {
                            setRpcParams((prev) => ({
                              ...prev,
                              [param.name]: option?.value
                            }));
                          }}
                          options={[
                            { label: "Yes", value: true },
                            { label: "No", value: false }
                          ]}
                          isClearable
                        />
                      ) : param.type === "number" ? (
                        <Input
                          type="number"
                          value={rpcParams[param.name] as number | undefined}
                          onChange={(e) => {
                            const val = e.target.value ? Number(e.target.value) : undefined;
                            setRpcParams((prev) => ({
                              ...prev,
                              [param.name]: val
                            }));
                          }}
                          placeholder={`Enter ${param.label.toLowerCase()}`}
                        />
                      ) : (
                        <Input
                          value={(rpcParams[param.name] as string) || ""}
                          onChange={(e) => {
                            setRpcParams((prev) => ({
                              ...prev,
                              [param.name]: e.target.value || undefined
                            }));
                          }}
                          placeholder={`Enter ${param.label.toLowerCase()}`}
                        />
                      )}
                    </Field.Root>
                  ))}
                </>
              )}

              <Button
                onClick={fetchRecipients}
                loading={isLoadingRecipients}
                disabled={selectedTemplate.requires_assignment && !selectedAssignment}
              >
                <HStack gap={2}>
                  <LuRefreshCw size={16} />
                  <Text>Fetch Recipients</Text>
                </HStack>
              </Button>
            </VStack>
          </Card.Body>
        </Card.Root>
      )}

      {/* Recipients Preview */}
      {selectedTemplate && recipients.length > 0 && (
        <Card.Root>
          <Card.Header>
            <HStack justify="space-between">
              <HStack gap={2}>
                <Icon>
                  <LuUsers size={18} />
                </Icon>
                <Card.Title>3. Recipients</Card.Title>
              </HStack>
              <Badge colorPalette="blue">{recipients.length} recipient(s)</Badge>
            </HStack>
          </Card.Header>
          <Card.Body p={0}>
            <Box maxH="300px" overflowY="auto">
              <Table.Root size="sm">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Name</Table.ColumnHeader>
                    <Table.ColumnHeader>Email</Table.ColumnHeader>
                    {selectedTemplate.available_variables
                      ?.filter((v) => !["user_id", "email", "private_profile_id", "course_name"].includes(v))
                      .slice(0, 3)
                      .map((v) => (
                        <Table.ColumnHeader key={v}>{v.replace(/_/g, " ")}</Table.ColumnHeader>
                      ))}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {recipients.slice(0, 20).map((r, idx) => (
                    <Table.Row key={r.user_id + idx}>
                      <Table.Cell>
                        {(r.student_name as string) || (r.leader_name as string) || "N/A"}
                      </Table.Cell>
                      <Table.Cell>{r.email}</Table.Cell>
                      {selectedTemplate.available_variables
                        ?.filter((v) => !["user_id", "email", "private_profile_id", "course_name"].includes(v))
                        .slice(0, 3)
                        .map((v) => (
                          <Table.Cell key={v}>
                            {r[v] !== undefined && r[v] !== null ? String(r[v]) : "—"}
                          </Table.Cell>
                        ))}
                    </Table.Row>
                  ))}
                  {recipients.length > 20 && (
                    <Table.Row>
                      <Table.Cell colSpan={5} textAlign="center">
                        <Text color="fg.muted" fontSize="sm">
                          ... and {recipients.length - 20} more
                        </Text>
                      </Table.Cell>
                    </Table.Row>
                  )}
                </Table.Body>
              </Table.Root>
            </Box>
          </Card.Body>
        </Card.Root>
      )}

      {/* Available Variables Reference */}
      {selectedTemplate && (
        <Card.Root>
          <Card.Header>
            <HStack gap={2}>
              <Icon>
                <LuCode size={18} />
              </Icon>
              <Card.Title>Available Template Variables</Card.Title>
            </HStack>
          </Card.Header>
          <Card.Body>
            <Text fontSize="sm" color="fg.muted" mb={3}>
              Use these variables in your subject and body. They will be replaced with actual values
              for each recipient.
            </Text>
            <Flex wrap="wrap" gap={2}>
              {selectedTemplate.available_variables?.map((variable) => (
                <Badge
                  key={variable}
                  colorPalette="blue"
                  size="sm"
                  title={selectedTemplate.variable_descriptions?.[variable] || ""}
                >
                  {`{${variable}}`}
                </Badge>
              ))}
            </Flex>
          </Card.Body>
        </Card.Root>
      )}

      {/* Email Composition */}
      {selectedTemplate && recipients.length > 0 && (
        <Card.Root>
          <Card.Header>
            <HStack gap={2}>
              <Icon>
                <LuMail size={18} />
              </Icon>
              <Card.Title>4. Compose Email</Card.Title>
            </HStack>
          </Card.Header>
          <Card.Body>
            <VStack align="stretch" gap={4}>
              <Field.Root>
                <Field.Label>Reply-To Email (optional)</Field.Label>
                <Input
                  value={replyEmail}
                  onChange={(e) => setReplyEmail(e.target.value)}
                  placeholder="Leave empty to use your email"
                />
              </Field.Root>

              <Field.Root required>
                <Field.Label>Subject</Field.Label>
                <Input
                  value={subjectLine}
                  onChange={(e) => setSubjectLine(e.target.value)}
                  placeholder="Email subject..."
                />
              </Field.Root>

              <Field.Root required>
                <Field.Label>Body</Field.Label>
                <MdEditor
                  uploadFolder="emails"
                  textareaProps={{ "aria-label": "Email body" }}
                  value={bodyText}
                  onChange={(value) => setBodyText(value ?? "")}
                  style={{ height: "250px" }}
                />
              </Field.Root>

              {/* Preview */}
              {recipients.length > 0 && (
                <Accordion.Root collapsible>
                  <Accordion.Item value="preview">
                    <Accordion.ItemTrigger>
                      <HStack gap={2}>
                        <LuEye size={16} />
                        <Text>Preview (first recipient)</Text>
                      </HStack>
                    </Accordion.ItemTrigger>
                    <Accordion.ItemContent>
                      <Box p={4} bg="bg.subtle" borderRadius="md">
                        <Text fontWeight="medium" mb={2}>
                          Subject: {replaceVariables(subjectLine, recipients[0])}
                        </Text>
                        <Separator my={2} />
                        <Box whiteSpace="pre-wrap" fontSize="sm">
                          {replaceVariables(bodyText, recipients[0])}
                        </Box>
                      </Box>
                    </Accordion.ItemContent>
                  </Accordion.Item>
                </Accordion.Root>
              )}

              <Button
                colorPalette="blue"
                onClick={handleAddToPreview}
                disabled={!subjectLine || !bodyText}
              >
                <HStack gap={2}>
                  <LuSend size={16} />
                  <Text>Add {recipients.length} Email(s) to Preview</Text>
                </HStack>
              </Button>
            </VStack>
          </Card.Body>
        </Card.Root>
      )}

      {/* Quick fetch for non-assignment templates */}
      {selectedTemplate && !selectedTemplate.requires_assignment && recipients.length === 0 && (
        <Card.Root>
          <Card.Body>
            <VStack gap={4}>
              <Text color="fg.muted">Click below to fetch recipients using the template query.</Text>
              <Button onClick={fetchRecipients} loading={isLoadingRecipients}>
                <HStack gap={2}>
                  <LuRefreshCw size={16} />
                  <Text>Fetch Recipients</Text>
                </HStack>
              </Button>
            </VStack>
          </Card.Body>
        </Card.Root>
      )}
    </VStack>
  );
}
