"use client";

import Link from "@/components/ui/link";
import { toaster } from "@/components/ui/toaster";
import { useAssignmentController } from "@/hooks/useAssignment";
import { useIsInstructor } from "@/hooks/useClassProfiles";
import { useCourseController } from "@/hooks/useCourseController";
import { createClient } from "@/utils/supabase/client";
import {
  Alert,
  Box,
  Button,
  Card,
  Field,
  Heading,
  HStack,
  Icon,
  Input,
  Spinner,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import { useParams } from "next/navigation";
import Papa from "papaparse";
import { useCallback, useMemo, useState } from "react";
import { FaDownload, FaExclamationTriangle, FaSearch, FaShieldAlt } from "react-icons/fa";

type SecurityAuditResult = {
  student_name: string;
  student_email: string;
  class_section_name: string | null;
  lab_section_name: string | null;
  submission_id: number;
  submission_ordinal: number;
  file_name: string;
  file_id: number;
  repository: string;
  sha: string;
  matched_content: string;
  match_line_number: number;
};

function getMatchContext(contents: string, searchTerm: string, maxLength: number = 100): { snippet: string; lineNumber: number } {
  const lowerContents = contents.toLowerCase();
  const lowerSearch = searchTerm.toLowerCase();
  const matchIndex = lowerContents.indexOf(lowerSearch);
  
  if (matchIndex === -1) {
    return { snippet: "", lineNumber: 0 };
  }
  
  // Calculate line number
  const linesBeforeMatch = contents.substring(0, matchIndex).split("\n");
  const lineNumber = linesBeforeMatch.length;
  
  // Get context around the match
  const contextStart = Math.max(0, matchIndex - Math.floor(maxLength / 3));
  const contextEnd = Math.min(contents.length, matchIndex + searchTerm.length + Math.floor(maxLength * 2 / 3));
  
  let snippet = contents.substring(contextStart, contextEnd);
  
  // Add ellipsis if truncated
  if (contextStart > 0) snippet = "..." + snippet;
  if (contextEnd < contents.length) snippet = snippet + "...";
  
  // Clean up the snippet (replace newlines with spaces for display)
  snippet = snippet.replace(/\n/g, " ").replace(/\s+/g, " ");
  
  return { snippet, lineNumber };
}

function getGitHubFileLink(repository: string, sha: string, fileName: string): string {
  return `https://github.com/${repository}/blob/${sha}/${fileName}`;
}

export default function SecurityAuditPage() {
  const { assignment_id, course_id } = useParams();
  const { assignment } = useAssignmentController();
  const { course } = useCourseController();
  const isInstructor = useIsInstructor();
  
  const [searchTerm, setSearchTerm] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<SecurityAuditResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  
  const supabase = useMemo(() => createClient(), []);
  
  const performSearch = useCallback(async () => {
    if (!searchTerm.trim()) {
      toaster.error({ title: "Error", description: "Please enter a search term" });
      return;
    }
    
    setIsSearching(true);
    setHasSearched(true);
    
    try {
      // Fetch all submission files for this assignment with related data
      const { data: submissionFiles, error: filesError } = await supabase
        .from("submission_files")
        .select(`
          id,
          name,
          contents,
          submission_id,
          submissions!inner(
            id,
            ordinal,
            sha,
            repository,
            profile_id,
            assignment_id
          )
        `)
        .eq("submissions.assignment_id", Number(assignment_id));
      
      if (filesError) {
        throw new Error(`Failed to fetch submission files: ${filesError.message}`);
      }
      
      // Get all student profiles and user data for this class
      const { data: userRoles, error: rolesError } = await supabase
        .from("user_roles")
        .select(`
          private_profile_id,
          class_section_id,
          lab_section_id,
          profiles!user_roles_private_profile_id_fkey(id, name),
          users(email),
          class_sections(name),
          lab_sections(name)
        `)
        .eq("class_id", Number(course_id))
        .eq("role", "student");
      
      if (rolesError) {
        throw new Error(`Failed to fetch user roles: ${rolesError.message}`);
      }
      
      // Create lookup maps
      const profileToUserData = new Map<string, {
        name: string;
        email: string;
        class_section_name: string | null;
        lab_section_name: string | null;
      }>();
      
      for (const role of userRoles || []) {
        if (role.profiles?.id) {
          profileToUserData.set(role.profiles.id, {
            name: role.profiles.name || "Unknown",
            email: role.users?.email || "Unknown",
            class_section_name: role.class_sections?.name || null,
            lab_section_name: role.lab_sections?.name || null
          });
        }
      }
      
      // Search through files
      const searchResults: SecurityAuditResult[] = [];
      const lowerSearchTerm = searchTerm.toLowerCase();
      
      for (const file of submissionFiles || []) {
        if (!file.contents) continue;
        
        if (file.contents.toLowerCase().includes(lowerSearchTerm)) {
          const submission = file.submissions as {
            id: number;
            ordinal: number;
            sha: string;
            repository: string;
            profile_id: string;
            assignment_id: number;
          };
          
          const userData = profileToUserData.get(submission.profile_id);
          const { snippet, lineNumber } = getMatchContext(file.contents, searchTerm);
          
          searchResults.push({
            student_name: userData?.name || "Unknown",
            student_email: userData?.email || "Unknown",
            class_section_name: userData?.class_section_name || null,
            lab_section_name: userData?.lab_section_name || null,
            submission_id: submission.id,
            submission_ordinal: submission.ordinal,
            file_name: file.name,
            file_id: file.id,
            repository: submission.repository,
            sha: submission.sha,
            matched_content: snippet,
            match_line_number: lineNumber
          });
        }
      }
      
      setResults(searchResults);
      
      if (searchResults.length === 0) {
        toaster.info({ title: "No matches found", description: `No submission files contain "${searchTerm}"` });
      } else {
        toaster.success({ 
          title: "Search complete", 
          description: `Found ${searchResults.length} match${searchResults.length === 1 ? "" : "es"} in ${new Set(searchResults.map(r => r.submission_id)).size} submission${new Set(searchResults.map(r => r.submission_id)).size === 1 ? "" : "s"}` 
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      toaster.error({ title: "Search failed", description: errorMessage });
      console.error("Security audit search error:", error);
    } finally {
      setIsSearching(false);
    }
  }, [searchTerm, supabase, assignment_id, course_id]);
  
  const exportToCSV = useCallback(() => {
    if (results.length === 0) {
      toaster.error({ title: "Error", description: "No results to export" });
      return;
    }
    
    const csvData = results.map(result => ({
      "Student Name": result.student_name,
      "Student Email": result.student_email,
      "Class Section": result.class_section_name || "N/A",
      "Lab Section": result.lab_section_name || "N/A",
      "Submission ID": result.submission_id,
      "Submission #": result.submission_ordinal,
      "File Name": result.file_name,
      "Line Number": result.match_line_number,
      "GitHub Link": getGitHubFileLink(result.repository, result.sha, result.file_name),
      "Matched Content": result.matched_content,
      "Search Term": searchTerm
    }));
    
    const csv = Papa.unparse(csvData);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `security_audit_${assignment?.slug || assignment_id}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    
    toaster.success({ title: "Export complete", description: "CSV file downloaded" });
  }, [results, searchTerm, assignment, assignment_id]);
  
  if (!isInstructor) {
    return (
      <Alert.Root status="error">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Access Denied</Alert.Title>
          <Alert.Description>
            Only instructors can access the security audit dashboard.
          </Alert.Description>
        </Alert.Content>
      </Alert.Root>
    );
  }
  
  return (
    <VStack w="100%" align="stretch" gap={4}>
      <HStack gap={2}>
        <Icon as={FaShieldAlt} color="red.500" boxSize={6} />
        <Heading size="md">Security Audit Dashboard</Heading>
      </HStack>
      
      <Alert.Root status="warning">
        <Alert.Indicator>
          <Icon as={FaExclamationTriangle} />
        </Alert.Indicator>
        <Alert.Content>
          <Alert.Title>Security Tool</Alert.Title>
          <Alert.Description>
            This tool searches all submission file contents for a specific string match.
            Use it to detect potential academic integrity violations, hidden backdoors, or other security concerns.
          </Alert.Description>
        </Alert.Content>
      </Alert.Root>
      
      <Card.Root>
        <Card.Body>
          <VStack gap={4} align="stretch">
            <Field.Root>
              <Field.Label>Search Term</Field.Label>
              <HStack>
                <Input
                  placeholder="Enter string to search for in all submission files..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !isSearching) {
                      performSearch();
                    }
                  }}
                  data-testid="security-search-input"
                />
                <Button
                  colorPalette="blue"
                  onClick={performSearch}
                  loading={isSearching}
                  disabled={isSearching || !searchTerm.trim()}
                  data-testid="security-search-button"
                >
                  <Icon as={FaSearch} mr={2} />
                  Search All Submissions
                </Button>
              </HStack>
              <Field.HelperText>
                Search is case-insensitive and searches the full contents of all submission files.
              </Field.HelperText>
            </Field.Root>
          </VStack>
        </Card.Body>
      </Card.Root>
      
      {isSearching && (
        <VStack py={8}>
          <Spinner size="lg" />
          <Text>Searching through all submission files...</Text>
        </VStack>
      )}
      
      {!isSearching && hasSearched && (
        <>
          <HStack justify="space-between">
            <Text fontWeight="medium">
              {results.length} match{results.length === 1 ? "" : "es"} found
              {results.length > 0 && ` across ${new Set(results.map(r => r.submission_id)).size} submission${new Set(results.map(r => r.submission_id)).size === 1 ? "" : "s"}`}
            </Text>
            {results.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={exportToCSV}
                data-testid="security-export-csv"
              >
                <Icon as={FaDownload} mr={2} />
                Export All to CSV
              </Button>
            )}
          </HStack>
          
          {results.length > 0 && (
            <Box overflowX="auto" maxH="600px" overflowY="auto">
              <Table.Root size="sm" data-testid="security-results-table">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Student Name</Table.ColumnHeader>
                    <Table.ColumnHeader>Student Email</Table.ColumnHeader>
                    <Table.ColumnHeader>Class Section</Table.ColumnHeader>
                    <Table.ColumnHeader>Lab Section</Table.ColumnHeader>
                    <Table.ColumnHeader>Submission ID</Table.ColumnHeader>
                    <Table.ColumnHeader>File Name</Table.ColumnHeader>
                    <Table.ColumnHeader>Matched Content</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {results.map((result, index) => (
                    <Table.Row key={`${result.submission_id}-${result.file_id}-${index}`}>
                      <Table.Cell>
                        <Link
                          href={`/course/${course_id}/assignments/${assignment_id}/submissions/${result.submission_id}`}
                          data-testid={`result-student-name-${index}`}
                        >
                          {result.student_name}
                        </Link>
                      </Table.Cell>
                      <Table.Cell data-testid={`result-student-email-${index}`}>
                        {result.student_email}
                      </Table.Cell>
                      <Table.Cell data-testid={`result-class-section-${index}`}>
                        {result.class_section_name || "N/A"}
                      </Table.Cell>
                      <Table.Cell data-testid={`result-lab-section-${index}`}>
                        {result.lab_section_name || "N/A"}
                      </Table.Cell>
                      <Table.Cell>
                        <Link
                          href={`/course/${course_id}/assignments/${assignment_id}/submissions/${result.submission_id}`}
                          data-testid={`result-submission-id-${index}`}
                        >
                          #{result.submission_ordinal}
                        </Link>
                      </Table.Cell>
                      <Table.Cell>
                        <Link
                          href={getGitHubFileLink(result.repository, result.sha, result.file_name)}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid={`result-file-link-${index}`}
                        >
                          {result.file_name}
                          <Text as="span" fontSize="xs" color="gray.500" ml={1}>
                            (L{result.match_line_number})
                          </Text>
                        </Link>
                      </Table.Cell>
                      <Table.Cell maxW="400px">
                        <Text
                          fontSize="xs"
                          fontFamily="mono"
                          whiteSpace="pre-wrap"
                          wordBreak="break-all"
                          data-testid={`result-matched-content-${index}`}
                        >
                          {result.matched_content}
                        </Text>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
          )}
          
          {results.length === 0 && (
            <Card.Root>
              <Card.Body>
                <VStack py={8}>
                  <Icon as={FaSearch} boxSize={8} color="gray.400" />
                  <Text color="gray.500">
                    No matches found for &quot;{searchTerm}&quot;
                  </Text>
                </VStack>
              </Card.Body>
            </Card.Root>
          )}
        </>
      )}
      
      {!hasSearched && !isSearching && (
        <Card.Root>
          <Card.Body>
            <VStack py={8}>
              <Icon as={FaShieldAlt} boxSize={8} color="gray.400" />
              <Text color="gray.500">
                Enter a search term above to scan all submission files
              </Text>
            </VStack>
          </Card.Body>
        </Card.Root>
      )}
    </VStack>
  );
}
