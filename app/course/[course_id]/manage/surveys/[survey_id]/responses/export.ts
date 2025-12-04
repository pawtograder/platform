import { Model } from "survey-core";

export type SurveyResponse = {
  id: string;
  response: Record<string, unknown>;
  is_submitted: boolean;
  submitted_at?: string;
  created_at: string;
  updated_at: string;
  profiles: {
    id: string;
    name: string;
    sis_user_id: string | null;
  };
};

export type Survey = {
  id: string;
  title: string;
  questions: unknown;
};

/**
 * Flattens nested response data into a flat object for CSV export
 */
function flattenResponseData(responseData: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(responseData)) {
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (Array.isArray(value)) {
      // Handle arrays (e.g., multi-select questions)
      flattened[newKey] = value.join(", ");
    } else if (value && typeof value === "object") {
      // Handle nested objects
      Object.assign(flattened, flattenResponseData(value as Record<string, unknown>, newKey));
    } else {
      // Handle primitive values
      flattened[newKey] = value || "";
    }
  }

  return flattened;
}

/**
 * Gets question titles from survey JSON for CSV headers
 */
function getQuestionTitles(surveyJson: unknown): Record<string, string> {
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
    console.warn("Error parsing survey JSON for question titles:", error);
  }

  return titles;
}

/**
 * Exports survey responses to CSV format
 */
export function exportResponsesToCSV(responses: SurveyResponse[], survey: Survey): string {
  if (responses.length === 0) {
    return "No responses to export";
  }

  // Get question titles for headers
  const questionTitles = getQuestionTitles(survey.questions);

  // Get all unique question names from all responses
  const allQuestionNames = new Set<string>();
  responses.forEach((response) => {
    Object.keys(flattenResponseData(response.response)).forEach((key) => {
      allQuestionNames.add(key);
    });
  });

  // Create CSV headers
  const headers = [
    "Student Name",
    "SIS User ID",
    "Status",
    "Submitted At",
    "Last Updated",
    ...Array.from(allQuestionNames).map((name) => questionTitles[name] || name)
  ];

  // Create CSV rows
  const rows = responses.map((response) => {
    const flattenedResponse = flattenResponseData(response.response);
    const studentName = response.profiles.name;
    const status = response.is_submitted ? "Completed" : "Partial";
    const submittedAt = response.submitted_at || "";
    const lastUpdated = response.updated_at;

    const row = [
      studentName,
      response.profiles.sis_user_id || "No SIS ID",
      status,
      submittedAt,
      lastUpdated,
      ...Array.from(allQuestionNames).map((name) => flattenedResponse[name] || "")
    ];

    return row;
  });

  // Convert to CSV format
  const csvContent = [
    headers.join(","),
    ...rows.map((row) =>
      row
        .map((cell) => {
          // Escape commas and quotes in CSV
          const cellStr = String(cell || "");
          if (cellStr.includes(",") || cellStr.includes('"') || cellStr.includes("\n")) {
            return `"${cellStr.replace(/"/g, '""')}"`;
          }
          return cellStr;
        })
        .join(",")
    )
  ].join("\n");

  return csvContent;
}

/**
 * Downloads CSV content as a file with UTF-8 BOM for Excel compatibility
 */
function downloadCSV(csvContent: string, filename: string) {
  // Add UTF-8 BOM so Excel properly recognizes encoding
  const BOM = "\uFEFF";
  const blob = new Blob([BOM + csvContent], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");

  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}

/**
 * Main export function that exports survey responses to CSV format
 */
export function exportSurveyResponses(responses: SurveyResponse[], survey: Survey) {
  if (responses.length === 0) {
    throw new Error("No responses to export");
  }

  const timestamp = new Date().toISOString().split("T")[0];
  const filename = `${survey.title.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_responses_${timestamp}.csv`;

  const csvContent = exportResponsesToCSV(responses, survey);
  downloadCSV(csvContent, filename);
}
