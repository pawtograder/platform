"use client";

import { Box, Container, Heading, Text, VStack, HStack, Table, Button, Input, Badge, Icon } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { formatInTimeZone } from "date-fns-tz";
import { TZDate } from "@date-fns/tz";
import { isWithinInterval, parseISO, differenceInDays, differenceInHours, isPast } from "date-fns";
import { useRouter } from "next/navigation";
import { Model } from "survey-core";
import { useMemo, useCallback, useState, useEffect } from "react";
import { FiX, FiFilter } from "react-icons/fi";
import type { SurveyResponseWithProfile, Survey } from "@/types/survey";


type SurveyResponsesViewProps = {
  courseId: string;
  surveyId: string; // The UUID
  surveyTitle: Survey["title"];
  surveyVersion: number;
  surveyStatus: Survey["status"];
  surveyJson: Survey["json"]; // The JSON configuration of the survey
  surveyDueDate: Survey["due_date"]; // The deadline for the survey
  responses: SurveyResponseWithProfile[];
  totalStudents: number;
};

/**
 * Gets question titles from survey JSON for dynamic column headers
 */
function getQuestionTitles(surveyJson: Record<string, unknown>): Record<string, string> {
  const titles: Record<string, string> = {};

  try {
    const survey = new Model(surveyJson);

    // Get all questions from the survey
    survey.getAllQuestions().forEach((question) => {
      if (question.name) {
        titles[question.name] = question.title || question.name;
      }
    });
  } catch (error) {
    // Error parsing survey JSON for question titles
    void error;
  }

  return titles;
}

/**
 * Formats response values for display in the table
 */
function formatResponseValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.join(", ");
  }

  if (typeof value === "object") {
    // For complex objects, try to extract meaningful data
    const obj = value as Record<string, unknown>;
    if (obj.text && typeof obj.text === "string") return obj.text;
    if (obj.value) return String(obj.value);
    if (obj.name && typeof obj.name === "string") return obj.name;
    if (obj.title && typeof obj.title === "string") return obj.title;

    // If it's a simple object with string values, join them
    const stringValues = Object.values(obj).filter((v) => typeof v === "string");
    if (stringValues.length > 0) {
      return stringValues.join(", ");
    }

    // Last resort: JSON stringify (truncated)
    const jsonStr = JSON.stringify(value);
    return jsonStr.length > 50 ? jsonStr.substring(0, 50) + "..." : jsonStr;
  }

  return String(value);
}

function escapeCSVValue(value: string): string {
  if (value === null || value === undefined) {
    return "";
  }

  const stringValue = String(value);

  // if string value contains comma, quote, or newline, wrap in quotes and escape internal quotes
  if (stringValue.includes(",") || stringValue.includes('"') || stringValue.includes("\n")) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

export default function SurveyResponsesView({
  courseId,
  surveyTitle,
  surveyVersion,
  surveyJson,
  surveyDueDate,
  responses,
  totalStudents
}: SurveyResponsesViewProps) {
  const router = useRouter();

  // Filter state
  const [dateRangeStart, setDateRangeStart] = useState<string>("");
  const [dateRangeEnd, setDateRangeEnd] = useState<string>("");
  const [selectedQuestions, setSelectedQuestions] = useState<string[]>([]); // Questions to show in table
  const [showFilters, setShowFilters] = useState(false);
  const [anonymousMode, setAnonymousMode] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());

  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const headerBgColor = useColorModeValue("#F2F2F2", "#0D0D0D");
  const headerTextColor = useColorModeValue("#1A202C", "#9CA3AF");
  const tableRowBg = useColorModeValue("#E5E5E5", "#1A1A1A");
  const emptyStateTextColor = useColorModeValue("#6B7280", "#718096");
  const filterBadgeBg = useColorModeValue("#3B82F6", "#2563EB");
  const overdueColor = useColorModeValue("#DC2626", "#EF4444");
  const urgentColor = useColorModeValue("#D97706", "#F59E0B");

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000); // Update every minute

    return () => clearInterval(interval);
  }, []);

  const totalResponses = responses.length;

  // Get dynamic question columns from survey JSON
  const questionTitles = useMemo(() => {
    return getQuestionTitles(surveyJson);
  }, [surveyJson]);

  // Get all unique question names from responses
  const allQuestionNames = useMemo(() => {
    const questionNames = new Set<string>();
    responses.forEach((response) => {
      if (response.response) {
        Object.keys(response.response).forEach((key) => {
          questionNames.add(key);
        });
      }
    });
    return Array.from(questionNames);
  }, [responses]);

  // Filter responses based on active filters
  const filteredResponses = useMemo(() => {
    let filtered = responses;

    // Date range filter
    if (dateRangeStart && dateRangeEnd) {
      try {
        const startDate = parseISO(dateRangeStart);
        const endDate = parseISO(dateRangeEnd);
        filtered = filtered.filter((response) => {
          const submittedDate = parseISO(response.submitted_at);
          return isWithinInterval(submittedDate, { start: startDate, end: endDate });
        });
      } catch (error) {
        // Error parsing date range
        void error;
      }
    }

    return filtered;
  }, [responses, dateRangeStart, dateRangeEnd]);

  // Determine which questions to show in table
  const visibleQuestions = useMemo(() => {
    if (selectedQuestions.length > 0) {
      return selectedQuestions;
    }
    return allQuestionNames;
  }, [selectedQuestions, allQuestionNames]);

  // Count active filters
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (dateRangeStart && dateRangeEnd) count++;
    if (selectedQuestions.length > 0) count++;
    if (anonymousMode) count++;
    return count;
  }, [dateRangeStart, dateRangeEnd, selectedQuestions, anonymousMode]);

  // Clear all filters
  const clearAllFilters = useCallback(() => {
    setDateRangeStart("");
    setDateRangeEnd("");
    setSelectedQuestions([]);
    setAnonymousMode(false);
  }, []);

  // Toggle question selection
  const toggleQuestion = useCallback((questionName: string) => {
    setSelectedQuestions((prev) => {
      if (prev.includes(questionName)) {
        return prev.filter((q) => q !== questionName);
      } else {
        return [...prev, questionName];
      }
    });
  }, []);

  const responseRate = totalStudents > 0 ? ((filteredResponses.length / totalStudents) * 100).toFixed(0) : 0;

  // Calculate time remaining until deadline
  let timeRemaining = "—";
  let isOverdue = false;
  let isLessThan24Hours = false;
  if (surveyDueDate) {
    const dueDate = new Date(surveyDueDate);

    if (isPast(dueDate)) {
      timeRemaining = "Closed";
      isOverdue = true;
    } else {
      const totalHoursLeft = differenceInHours(dueDate, currentTime);
      const daysLeft = differenceInDays(dueDate, currentTime);
      const hoursLeft = totalHoursLeft % 24;

      if (totalHoursLeft < 24) {
        isLessThan24Hours = true;
      }

      if (daysLeft > 0) {
        timeRemaining = `${daysLeft} day${daysLeft !== 1 ? "s" : ""}${hoursLeft > 0 ? `, ${hoursLeft}h` : ""}`;
      } else if (hoursLeft > 0) {
        const minutesLeft = Math.floor((dueDate.getTime() - currentTime.getTime()) / (1000 * 60)) % 60;
        timeRemaining = `${hoursLeft}h${minutesLeft > 0 ? ` ${minutesLeft}m` : ""}`;
      } else {
        const minutesLeft = Math.floor((dueDate.getTime() - currentTime.getTime()) / (1000 * 60));
        timeRemaining = minutesLeft > 0 ? `${minutesLeft}m` : "Less than 1m";
      }
    }
  }

  const exportToCSV = useCallback(() => {
    if (filteredResponses.length === 0) {
      return;
    }

    const headers = [
      "Student Name",
      "Submitted At",
      ...allQuestionNames.map((questionName) => questionTitles[questionName] || questionName)
    ];

    const csvRows = filteredResponses.map((response) => {
      const row = [
        response.profiles?.name || "N/A",
        response.submitted_at
          ? formatInTimeZone(new TZDate(response.submitted_at), "America/New_York", "MMM d, yyyy, h:mm a")
          : "—",
        ...allQuestionNames.map((questionName) => {
          const value = response.response?.[questionName];
          return formatResponseValue(value);
        })
      ];
      return row.map(escapeCSVValue).join(",");
    });

    const csvContent = [headers.map(escapeCSVValue).join(","), ...csvRows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute(
      "download",
      `survey-responses-${surveyTitle.replace(/[^a-z0-9]/gi, "_")}-${new Date().toISOString().split("T")[0]}.csv`
    );
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [filteredResponses, allQuestionNames, questionTitles, surveyTitle]);

  return (
    <Container py={8} maxW="1200px" my={2}>
      <VStack align="stretch" gap={4} w="100%">
        {/* Title */}
        <Heading size="2xl" color={textColor}>
          Survey Responses: {surveyTitle}
        </Heading>

        {/* Action Buttons */}
        <HStack justify="space-between" mb={4}>
          <Button
            variant="outline"
            size="sm"
            bg="transparent"
            borderColor={borderColor}
            color={textColor}
            _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
            onClick={() => router.push(`/course/${courseId}/manage/surveys`)}
          >
            ← Back to Surveys
          </Button>
          <HStack gap={2}>
            <Button
              size="sm"
              variant="outline"
              borderColor={borderColor}
              color={textColor}
              _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
              onClick={() => setShowFilters(!showFilters)}
            >
              <Icon as={FiFilter} mr={2} />
              Filters
              {activeFilterCount > 0 && (
                <Badge ml={2} bg={filterBadgeBg} color="white" borderRadius="full" px={2}>
                  {activeFilterCount}
                </Badge>
              )}
            </Button>
            <Button
              size="sm"
              variant="solid"
              bg="#22C55E"
              color="white"
              _hover={{ bg: "#16A34A" }}
              onClick={exportToCSV}
              disabled={filteredResponses.length === 0}
            >
              Export to CSV
            </Button>
          </HStack>
        </HStack>

        {/* Filter Panel */}
        {showFilters && (
          <Box bg={cardBgColor} border="1px solid" borderColor={borderColor} borderRadius="lg" p={4} mb={4}>
            <VStack align="stretch" gap={4}>
              <HStack justify="space-between">
                <Text fontWeight="bold" color={textColor}>
                  Filter Responses
                </Text>
                {activeFilterCount > 0 && (
                  <Button size="sm" variant="ghost" onClick={clearAllFilters}>
                    Clear All
                  </Button>
                )}
              </HStack>

              {/* Date Range Filter */}
              <Box>
                <Text fontSize="sm" fontWeight="medium" color={textColor} mb={2}>
                  Date Range
                </Text>
                <HStack gap={2}>
                  <Input
                    type="date"
                    size="sm"
                    value={dateRangeStart}
                    onChange={(e) => setDateRangeStart(e.target.value)}
                    placeholder="Start date"
                  />
                  <Text color={textColor}>to</Text>
                  <Input
                    type="date"
                    size="sm"
                    value={dateRangeEnd}
                    onChange={(e) => setDateRangeEnd(e.target.value)}
                    placeholder="End date"
                  />
                </HStack>
              </Box>

              {/* Anonymous Mode Toggle */}
              <Box>
                <Text fontSize="sm" fontWeight="medium" color={textColor} mb={2}>
                  Anonymous Mode
                </Text>
                <HStack gap={2}>
                  <input
                    type="checkbox"
                    checked={anonymousMode}
                    onChange={() => setAnonymousMode(!anonymousMode)}
                    style={{ cursor: "pointer" }}
                  />
                  <Text fontSize="sm" color={textColor}>
                    Hide student names and submission times
                  </Text>
                </HStack>
              </Box>

              {/* Filter by Question Columns */}
              {allQuestionNames.length > 0 && (
                <Box>
                  <Text fontSize="sm" fontWeight="medium" color={textColor} mb={2}>
                    Show Specific Questions (leave empty to show all)
                  </Text>
                  <VStack align="stretch" gap={2}>
                    {allQuestionNames.map((qName) => (
                      <HStack key={qName} gap={2}>
                        <input
                          type="checkbox"
                          checked={selectedQuestions.includes(qName)}
                          onChange={() => toggleQuestion(qName)}
                          style={{ cursor: "pointer" }}
                        />
                        <Text fontSize="sm" color={textColor}>
                          {questionTitles[qName] || qName}
                        </Text>
                      </HStack>
                    ))}
                  </VStack>
                </Box>
              )}
            </VStack>
          </Box>
        )}

        {/* Active Filters Display */}
        {activeFilterCount > 0 && (
          <HStack gap={2} wrap="wrap" mb={4}>
            {dateRangeStart && dateRangeEnd && (
              <Badge bg={filterBadgeBg} color="white" px={3} py={1} borderRadius="full">
                Date: {dateRangeStart} to {dateRangeEnd}
                <Icon
                  as={FiX}
                  ml={2}
                  cursor="pointer"
                  onClick={() => {
                    setDateRangeStart("");
                    setDateRangeEnd("");
                  }}
                />
              </Badge>
            )}
            {selectedQuestions.length > 0 && (
              <Badge bg={filterBadgeBg} color="white" px={3} py={1} borderRadius="full">
                Showing {selectedQuestions.length} question{selectedQuestions.length !== 1 ? "s" : ""}
                <Icon as={FiX} ml={2} cursor="pointer" onClick={() => setSelectedQuestions([])} />
              </Badge>
            )}
            {anonymousMode && (
              <Badge bg={filterBadgeBg} color="white" px={3} py={1} borderRadius="full">
                Anonymous Mode
                <Icon as={FiX} ml={2} cursor="pointer" onClick={() => setAnonymousMode(false)} />
              </Badge>
            )}
          </HStack>
        )}
      </VStack>

      <Text color={textColor} mb={6}>
        Viewing all responses for version {surveyVersion}
      </Text>

      {/* Summary Cards */}
      <HStack gap={4} mb={8} justify="flex-start" wrap="wrap">
        <Box
          bg={cardBgColor}
          border="1px solid"
          borderColor={borderColor}
          borderRadius="lg"
          p={4}
          minW="200px"
          flex="1"
        >
          <Text fontSize="sm" color={headerTextColor} mb={1}>
            TOTAL RESPONSES
          </Text>
          <Text fontSize="2xl" fontWeight="bold" color={textColor}>
            {filteredResponses.length}
            {activeFilterCount > 0 && (
              <Text as="span" fontSize="sm" color={headerTextColor} ml={2}>
                / {totalResponses}
              </Text>
            )}
          </Text>
        </Box>
        <Box
          bg={cardBgColor}
          border="1px solid"
          borderColor={borderColor}
          borderRadius="lg"
          p={4}
          minW="200px"
          flex="1"
        >
          <Text fontSize="sm" color={headerTextColor} mb={1}>
            RESPONSE RATE
          </Text>
          <Text fontSize="2xl" fontWeight="bold" color={textColor}>
            {responseRate}%
          </Text>
        </Box>
        <Box
          bg={cardBgColor}
          border="1px solid"
          borderColor={borderColor}
          borderRadius="lg"
          p={4}
          minW="200px"
          flex="1"
        >
          <Text fontSize="sm" color={headerTextColor} mb={1}>
            TIME REMAINING
          </Text>
          <Text
            fontSize="2xl"
            fontWeight="bold"
            color={
              isOverdue
                ? overdueColor
                : isLessThan24Hours
                  ? urgentColor
                  : textColor
            }
          >
            {timeRemaining}
          </Text>
        </Box>
      </HStack>

      {/* Responses Table */}
      <Box border="1px solid" borderColor={borderColor} borderRadius="lg" overflow="hidden" overflowX="auto">
        <Table.Root variant="outline" size="md">
          <Table.Header>
            <Table.Row bg={headerBgColor}>
              {!anonymousMode && (
                <>
                  <Table.ColumnHeader
                    color={headerTextColor}
                    fontSize="xs"
                    fontWeight="semibold"
                    textTransform="uppercase"
                    py={3}
                    pl={6}
                  >
                    STUDENT NAME
                  </Table.ColumnHeader>
                  <Table.ColumnHeader
                    color={headerTextColor}
                    fontSize="xs"
                    fontWeight="semibold"
                    textTransform="uppercase"
                    py={3}
                  >
                    SUBMITTED AT
                  </Table.ColumnHeader>
                </>
              )}
              {visibleQuestions.map((questionName, index) => (
                <Table.ColumnHeader
                  key={questionName}
                  color={headerTextColor}
                  fontSize="xs"
                  fontWeight="semibold"
                  textTransform="uppercase"
                  py={3}
                  pl={anonymousMode && index === 0 ? 6 : undefined}
                  pr={questionName === visibleQuestions[visibleQuestions.length - 1] ? 6 : undefined}
                >
                  {questionTitles[questionName] || questionName}
                </Table.ColumnHeader>
              ))}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {filteredResponses.length === 0 ? (
              <Table.Row bg={tableRowBg} borderColor={borderColor}>
                <Table.Cell colSpan={(anonymousMode ? 0 : 2) + visibleQuestions.length} py={4} textAlign="center">
                  <Text color={emptyStateTextColor}>
                    {totalResponses === 0
                      ? "Students haven't submitted any responses to this survey."
                      : "No responses match the current filters."}
                  </Text>
                </Table.Cell>
              </Table.Row>
            ) : (
              filteredResponses.map((response) => (
                <Table.Row key={response.id} bg={tableRowBg} borderColor={borderColor}>
                  {!anonymousMode && (
                    <>
                      <Table.Cell py={4} pl={6}>
                        <Text color={textColor}>{response.profiles?.name || "N/A"}</Text>
                      </Table.Cell>
                      <Table.Cell py={4}>
                        <Text color={textColor}>
                          {formatInTimeZone(
                            new TZDate(response.submitted_at),
                            "America/New_York",
                            "MMM d, yyyy, h:mm a"
                          )}
                        </Text>
                      </Table.Cell>
                    </>
                  )}
                  {visibleQuestions.map((questionName, index) => (
                    <Table.Cell
                      key={questionName}
                      py={4}
                      pl={anonymousMode && index === 0 ? 6 : undefined}
                      pr={questionName === visibleQuestions[visibleQuestions.length - 1] ? 6 : undefined}
                    >
                      <Text color={textColor}>{formatResponseValue(response.response?.[questionName])}</Text>
                    </Table.Cell>
                  ))}
                </Table.Row>
              ))
            )}
          </Table.Body>
        </Table.Root>
      </Box>
    </Container>
  );
}
