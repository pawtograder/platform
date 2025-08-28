import http from "k6/http";
import encoding from "k6/encoding";
import { sleep } from "k6";

// k6 globals
declare const __ENV: Record<string, string>;

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
  anonKey: string;
}

export interface AuthHeaders {
  Authorization: string;
  "Content-Type": string;
  apikey: string;
  Prefer: string;
}

export interface ClassData {
  id: number;
  name: string;
  slug: string;
  github_org: string;
  start_date: string;
  end_date: string;
  late_tokens_per_student: number;
  time_zone: string;
}

export interface AssignmentData {
  id: number;
  title: string;
  description: string;
  due_date: string;
  template_repo: string;
  autograder_points: number;
  total_points: number;
  max_late_tokens: number;
  release_date: string;
  class_id: number;
  slug: string;
  group_config: string;
  allow_not_graded_submissions: boolean;
  self_review_setting_id: number;
}

export interface StudentData {
  id: string;
  profile_id: string;
  email: string;
  user_id: string;
  public_profile_id: string;
  private_profile_id: string;
  magic_link: {
    hashed_token: string;
    verification_type: string;
    redirect_to?: string;
  };
  access_token: string;
  refresh_token: string;
}

export interface RepositoryData {
  id: number;
  name: string;
  student: StudentData;
  assignment: { id: number; title: string; due_date?: string; minutes_due_after_lab: number | null };
}

export interface SupabaseApiResponse<T = unknown> {
  status: number;
  body: string | null;
  data?: T;
}

/**
 * Safely parse JSON response body, handling empty responses and parse errors
 */
export function safeJsonParse(body: string | null): unknown {
  if (!body || body.trim() === "") {
    console.log("⚠️ Empty response body");
    return null;
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    console.log(`⚠️ JSON parse error: ${error}`);
    console.log(`Response body: "${body}"`);
    return null;
  }
}

/**
 * Get Supabase configuration from environment variables
 */
export function getSupabaseConfig(): SupabaseConfig {
  const url = __ENV.SUPABASE_URL;
  const serviceRoleKey = __ENV.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = __ENV.SUPABASE_ANON_KEY;

  if (!url || !serviceRoleKey || !anonKey) {
    throw new Error(
      "Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY"
    );
  }

  return { url, serviceRoleKey, anonKey };
}

/**
 * Create standard authentication headers for Supabase requests
 */
export function createAuthHeaders(serviceRoleKey: string): AuthHeaders {
  return {
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    apikey: serviceRoleKey,
    Prefer: "return=representation"
  };
}

/**
 * Make an authenticated HTTP request to Supabase REST API
 */
export function makeSupabaseRequest(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  endpoint: string,
  data: Record<string, unknown> | null = null,
  config: SupabaseConfig,
  headers?: Partial<AuthHeaders> & Record<string, string>
): SupabaseApiResponse {
  const authHeaders = createAuthHeaders(config.serviceRoleKey);
  const requestHeaders = { ...authHeaders, ...headers };

  const url = `${config.url}/rest/v1/${endpoint}`;
  const body = data ? JSON.stringify(data) : null;

  let response;
  switch (method) {
    case "GET":
      response = http.get(url, { headers: requestHeaders });
      break;
    case "POST":
      response = http.post(url, body, { headers: requestHeaders });
      break;
    case "PATCH":
      response = http.patch(url, body, { headers: requestHeaders });
      break;
    case "DELETE":
      response = http.del(url, body, { headers: requestHeaders });
      break;
    default:
      throw new Error(`Unsupported HTTP method: ${method}`);
  }

  return {
    status: response.status,
    body: response.body as string | null,
    data: safeJsonParse(response.body as string | null)
  };
}

/**
 * Select all rows that match a query across all pages with pagination
 * Uses page size of 1000 (Supabase maximum) and continues until all data is retrieved
 *
 * @example
 * // Get all classes
 * const allClasses = selectAllRows('classes', config);
 *
 * @example
 * // Get all students in a specific class
 * const classStudents = selectAllRows('user_roles', config, 'class_id=eq.123&role=eq.student');
 *
 * @example
 * // Get all submissions for an assignment with specific columns
 * const submissions = selectAllRows('submissions', config, 'assignment_id=eq.456&select=id,created_at,grade');
 *
 * @param endpoint - The Supabase table/view name (e.g., 'classes', 'user_roles', 'submissions')
 * @param config - Supabase configuration with URL and service role key
 * @param queryParams - Optional query string for filtering/selecting (e.g., 'class_id=eq.123&select=id,name')
 * @returns Array of all matching rows across all pages
 */
export function selectAllRows(endpoint: string, config: SupabaseConfig, queryParams: string = ""): unknown[] {
  const pageSize = 1000;
  let allData: unknown[] = [];
  let currentPage = 0;
  let hasMoreData = true;

  while (hasMoreData) {
    const rangeStart = currentPage * pageSize;
    const rangeEnd = rangeStart + pageSize - 1;

    // Add range header for pagination
    const paginationHeaders = {
      Range: `${rangeStart}-${rangeEnd}`
    };

    // Construct URL with query parameters
    const endpointWithQuery = queryParams ? `${endpoint}?${queryParams}` : endpoint;

    console.log(`📄 Fetching page ${currentPage + 1} (rows ${rangeStart}-${rangeEnd}) from ${endpointWithQuery}`);

    const response = makeSupabaseRequest("GET", endpointWithQuery, null, config, paginationHeaders);

    if (response.status !== 200 && response.status !== 206) {
      throw new Error(`Failed to fetch data from ${endpointWithQuery}: ${response.status} ${response.body}`);
    }

    const pageData = response.data;
    if (!pageData || !Array.isArray(pageData)) {
      throw new Error(`Invalid response data from ${endpointWithQuery}: expected array, got ${typeof pageData}`);
    }

    // Add this page's data to the total
    allData = allData.concat(pageData);

    // Check if we have more data to fetch
    // Supabase returns fewer than the requested page size when we've reached the end
    hasMoreData = pageData.length === pageSize;

    currentPage++;

    console.log(`✅ Fetched ${pageData.length} rows (total: ${allData.length})`);

    // Safety check to prevent infinite loops
    if (currentPage > 1000) {
      throw new Error("Too many pages - possible infinite loop. Check your query.");
    }
  }

  console.log(`🎉 Completed pagination: fetched ${allData.length} total rows across ${currentPage} pages`);
  return allData;
}

/**
 * Generate a magic link for a user using Supabase auth admin API
 */
export function generateMagicLink(
  email: string,
  config: SupabaseConfig,
  retryCount: number = 0
): { hashed_token: string; verification_type: string; redirect_to?: string } {

  const magicLinkPayload = {
    type: "magiclink",
    email: email,
    options: {
      redirect_to: `${config.url.replace("/supabase", "")}/auth/callback`
    }
  };

  const authHeaders = createAuthHeaders(config.serviceRoleKey);
  const response = http.post(`${config.url}/auth/v1/admin/generate_link`, JSON.stringify(magicLinkPayload), {
    headers: {
      ...authHeaders,
      "Content-Type": "application/json"
    }
  });

  // Handle rate limiting with exponential backoff
  if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
    if (retryCount < 3) {
      const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
      console.log(`⏳ Rate limited or server error (${response.status}), retrying in ${delay}ms...`);
      sleep(delay / 1000); // k6 sleep takes seconds
      return generateMagicLink(email, config, retryCount + 1);
    } else {
      throw new Error(`Failed to generate magic link for ${email} after ${retryCount + 1} attempts: ${response.status} - ${response.body}`);
    }
  }

  if (response.status !== 200) {
    throw new Error(`Failed to generate magic link for ${email}: ${response.status} - ${response.body}`);
  }

  const responseData = safeJsonParse(response.body as string) as {
    hashed_token: string;
    verification_type: string;
    redirect_to?: string;
  } | null;

  if (!responseData || !responseData.hashed_token || !responseData.verification_type) {
    console.log(`❌ Invalid magic link response data:`, responseData);
    throw new Error(`Magic link generation returned invalid data for ${email}`);
  }

  // Validate the hashed_token format (should be a non-empty string)
  if (typeof responseData.hashed_token !== 'string' || responseData.hashed_token.length === 0) {
    console.log(`❌ Invalid hashed_token format:`, responseData.hashed_token);
    throw new Error(`Magic link hashed_token is invalid for ${email}`);
  }

  // Validate the verification_type
  if (responseData.verification_type !== 'magiclink') {
    console.log(`❌ Unexpected verification_type:`, responseData.verification_type);
    throw new Error(`Magic link verification_type is invalid for ${email}: ${responseData.verification_type}`);
  }

  return responseData;
}

/**
 * Create a test class in Supabase
 */
export function createTestClass(testRunPrefix: string, config: SupabaseConfig): ClassData {
  console.log("📚 Creating test class...");

  const classPayload = {
    name: `Performance Test ${testRunPrefix}`,
    slug: `performance-test-${testRunPrefix}`,
    github_org: "pawtograder-playground",
    start_date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    end_date: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
    late_tokens_per_student: 10,
    time_zone: "America/New_York"
  };

  const response = makeSupabaseRequest("POST", "classes", classPayload, config);

  if (response.status !== 201) {
    throw new Error(`Failed to create class: ${response.status} ${response.body}`);
  }

  const responseData = response.data;
  if (!responseData || !Array.isArray(responseData) || responseData.length === 0) {
    throw new Error("Class creation failed - no data returned from API. Check if Prefer header is working.");
  }

  const classData = responseData[0] as ClassData;
  console.log(`✅ Created class: ${classData.name} (ID: ${classData.id})`);

  return classData;
}

/**
 * Create a self-review setting for an assignment
 */
export function createSelfReviewSetting(classId: number, config: SupabaseConfig): number {
  const selfReviewPayload = {
    class_id: classId,
    enabled: true,
    deadline_offset: 2,
    allow_early: true
  };

  const response = makeSupabaseRequest("POST", "assignment_self_review_settings", selfReviewPayload, config);

  if (response.status !== 201) {
    throw new Error(`Failed to create self-review setting: ${response.status} ${response.body}`);
  }

  const responseData = response.data;
  if (!responseData || !Array.isArray(responseData) || responseData.length === 0) {
    throw new Error("Self-review setting creation failed - no data returned");
  }

  return (responseData[0] as { id: number }).id;
}

/**
 * Create a test assignment in Supabase
 */
export function createTestAssignment(
  title: string,
  classId: number,
  testRunPrefix: string,
  assignmentIndex: number,
  config: SupabaseConfig
): AssignmentData {
  console.log(`📋 Creating assignment: ${title}`);

  // First create self-review setting
  const selfReviewSettingId = createSelfReviewSetting(classId, config);
  console.log(`✅ Created self-review setting ID: ${selfReviewSettingId}`);

  const assignmentPayload = {
    title,
    description: `Test assignment ${assignmentIndex + 1} for performance testing`,
    due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    template_repo: "pawtograder-playground/test-e2e-java-handout",
    autograder_points: 100,
    total_points: 100,
    max_late_tokens: 3,
    release_date: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    class_id: classId,
    slug: `perf-assignment-${assignmentIndex + 1}-${testRunPrefix}`,
    group_config: "individual",
    allow_not_graded_submissions: false,
    self_review_setting_id: selfReviewSettingId
  };

  const response = makeSupabaseRequest("POST", "assignments", assignmentPayload, config);

  if (response.status !== 201) {
    throw new Error(`Failed to create assignment: ${response.status} ${response.body}`);
  }

  const responseData = response.data;
  if (!responseData || !Array.isArray(responseData) || responseData.length === 0) {
    throw new Error("Assignment creation failed - no data returned");
  }

  const assignmentData = responseData[0] as AssignmentData;

  // Update autograder config
  const autograderPayload = {
    config: {
      submissionFiles: {
        files: ["**/*.java", "**/*.py", "**/*.arr", "**/*.ts"],
        testFiles: []
      }
    },
    max_submissions_count: null,
    max_submissions_period_secs: null
  };

  const autograderResponse = makeSupabaseRequest(
    "PATCH",
    `autograder?id=eq.${assignmentData.id}`,
    autograderPayload,
    config
  );

  if (autograderResponse.status !== 200 && autograderResponse.status !== 204) {
    console.log(
      `⚠️ Failed to update autograder config for assignment ${assignmentData.id}: ${autograderResponse.status}`
    );
  } else {
    console.log(`✅ Updated autograder config for assignment ${assignmentData.id}`);
  }

  console.log(`✅ Created assignment ID: ${assignmentData.id}`);
  return assignmentData;
}

/**
 * Create a test student (auth user + profiles + enrollment)
 */
export function createTestStudent(
  studentNumber: number,
  classId: number,
  testRunPrefix: string,
  workerIndex: string,
  config: SupabaseConfig
): StudentData {
  const email = `student-${testRunPrefix}-${workerIndex}-${studentNumber}@pawtograder.net`;
  const privateName = `Student #${studentNumber} Test`;
  const publicName = `Pseudonym #${studentNumber}`;
  const password = __ENV.TEST_PASSWORD || "change-it";

  console.log(`👤 Creating student: ${email}`);

  // Step 1: Create auth user
  const userPayload = {
    email,
    password,
    email_confirm: true
  };

  const authHeaders = createAuthHeaders(config.serviceRoleKey);
  const userResponse = http.post(`${config.url}/auth/v1/admin/users`, JSON.stringify(userPayload), {
    headers: {
      ...authHeaders,
      "Content-Type": "application/json"
    }
  });

  if (userResponse.status !== 200 && userResponse.status !== 201) {
    throw new Error(`Failed to create user ${email}: ${userResponse.status} - ${userResponse.body}`);
  }

  const userData = safeJsonParse(userResponse.body as string) as { id: string } | null;
  if (!userData || !userData.id) {
    throw new Error(`User creation returned invalid data for ${email}`);
  }

  const userId = userData.id;
  console.log(`✅ Created user ID: ${userId}`);

  // Step 2: Create public profile
  const publicProfilePayload = {
    name: publicName,
    avatar_url: `https://api.dicebear.com/9.x/identicon/svg?seed=test-user-${studentNumber}`,
    class_id: classId,
    is_private_profile: false
  };

  const publicProfileResponse = makeSupabaseRequest("POST", "profiles", publicProfilePayload, config);

  if (publicProfileResponse.status !== 201) {
    throw new Error(`Failed to create public profile for ${email}: ${publicProfileResponse.status}`);
  }

  const publicProfileData = publicProfileResponse.data;
  if (!publicProfileData || !Array.isArray(publicProfileData) || publicProfileData.length === 0) {
    throw new Error(`Public profile creation returned invalid data for ${email}`);
  }

  const publicProfileId = (publicProfileData[0] as { id: string }).id;
  console.log(`✅ Created public profile ID: ${publicProfileId}`);

  // Step 3: Create private profile
  const privateProfilePayload = {
    name: privateName,
    avatar_url: `https://api.dicebear.com/9.x/identicon/svg?seed=test-private-user-${studentNumber}`,
    class_id: classId,
    is_private_profile: true
  };

  const privateProfileResponse = makeSupabaseRequest("POST", "profiles", privateProfilePayload, config);

  if (privateProfileResponse.status !== 201) {
    throw new Error(`Failed to create private profile for ${email}: ${privateProfileResponse.status}`);
  }

  const privateProfileData = privateProfileResponse.data;
  if (!privateProfileData || !Array.isArray(privateProfileData) || privateProfileData.length === 0) {
    throw new Error(`Private profile creation returned invalid data for ${email}`);
  }

  const privateProfileId = (privateProfileData[0] as { id: string }).id;

  // Step 4: Create user role (enroll student in class)
  const userRolePayload = {
    user_id: userId,
    class_id: classId,
    private_profile_id: privateProfileId,
    public_profile_id: publicProfileId,
    role: "student"
  };

  const userRoleResponse = makeSupabaseRequest("POST", "user_roles", userRolePayload, config);

  if (userRoleResponse.status !== 201) {
    throw new Error(`Failed to create user role for ${email}: ${userRoleResponse.status}`);
  }

  // Step 5: Generate magic link for the student
  const magicLinkData = generateMagicLink(email, config);

  // Step 6: Immediately exchange magic link for access token (single-use tokens)
  const authData = exchangeMagicLinkForAccessToken(magicLinkData.hashed_token, config, email);

  return {
    id: `student-${testRunPrefix}-${studentNumber}`,
    profile_id: privateProfileId,
    email,
    user_id: userId,
    public_profile_id: publicProfileId,
    private_profile_id: privateProfileId,
    magic_link: magicLinkData,
    access_token: authData.access_token,
    refresh_token: authData.refresh_token
  };
}

/**
 * Create a repository for a student-assignment pair
 */
export function createTestRepository(
  student: StudentData,
  assignment: { id: number; title: string; due_date?: string, minutes_due_after_lab: number | null },
  classId: number,
  testRunPrefix: string,
  config: SupabaseConfig
): RepositoryData {
  const timestamp = Date.now();
  const studentId = student.id.slice(0, 8);
  const repositoryName = `pawtograder-playground/test-e2e-student-repo-java--${testRunPrefix}-setup-${assignment.id}-${studentId}-${timestamp}`;

  const repositoryPayload = {
    assignment_id: assignment.id,
    repository: repositoryName,
    class_id: classId,
    assignment_group_id: null,
    profile_id: student.private_profile_id,
    synced_handout_sha: "none"
  };

  const response = makeSupabaseRequest("POST", "repositories", repositoryPayload, config);

  if (response.status !== 201) {
    throw new Error(`Failed to create repository ${repositoryName}: ${response.status} ${response.body}`);
  }

  const responseData = response.data;
  if (!responseData || !Array.isArray(responseData) || responseData.length === 0) {
    throw new Error(`Repository creation returned invalid data for ${repositoryName}`);
  }

  const repositoryId = (responseData[0] as { id: number }).id;

  return {
    id: repositoryId,
    name: repositoryName,
    student,
    assignment
  };
}

/**
 * Create a repository check run
 */
export function createRepositoryCheckRun(
  classId: number,
  repositoryId: number,
  sha: string,
  config: SupabaseConfig
): void {
  const checkRunPayload = {
    class_id: classId,
    repository_id: repositoryId,
    check_run_id: Math.floor(Math.random() * 100000),
    status: "{}",
    sha,
    commit_message: "Performance test submission"
  };

  const response = makeSupabaseRequest("POST", "repository_check_runs", checkRunPayload, config);

  if (response.status !== 201) {
    throw new Error(`Failed to create check run: ${response.status} ${response.body}`);
  }
}

/**
 * Create a JWT token for submission authentication
 */
export function createSubmissionJwtToken(
  repository: string,
  sha: string,
  endToEndSecret: string = "not-a-secret"
): string {
  const payload = {
    repository,
    sha,
    workflow_ref: ".github/workflows/grade.yml-e2e-test",
    run_id: Math.floor(Math.random() * 100000),
    run_attempt: 1
  };

  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: endToEndSecret
  };

  // Create JWT token without signature (for testing purposes)
  return encoding.b64encode(JSON.stringify(header)) + "." + encoding.b64encode(JSON.stringify(payload)) + ".";
}

/**
 * Call the autograder-create-submission edge function
 */
export function createSubmission(
  repository: string,
  sha: string,
  config: SupabaseConfig,
  endToEndSecret?: string
): SupabaseApiResponse {
  const token = createSubmissionJwtToken(repository, sha, endToEndSecret);

  const response = http.post(`${config.url}/functions/v1/autograder-create-submission`, null, {
    headers: {
      Authorization: token,
      "Content-Type": "application/json"
    }
  });

  // console.log("Submission response: ", response.body)
  return {
    status: response.status,
    body: response.body as string | null,
    data: safeJsonParse(response.body as string | null)
  };
}

/**
 * Exchange magic link token for access token using Supabase auth API
 */
export function exchangeMagicLinkForAccessToken(
  hashedToken: string,
  config: SupabaseConfig,
  email?: string
): { access_token: string; refresh_token: string; user: Record<string, unknown> } {

  const exchangePayload = {
    token_hash: hashedToken,
    type: "magiclink"
  };

  const response = http.post(`${config.url}/auth/v1/verify`, JSON.stringify(exchangePayload), {
    headers: {
      "Content-Type": "application/json",
      apikey: config.serviceRoleKey
    }
  });

  if (response.status !== 200) {
    console.log(`Exchange response: ${response.status} - ${response.body}`);
    const emailInfo = email ? ` for ${email}` : '';
    throw new Error(`Failed to exchange magic link token${emailInfo} (${hashedToken}): ${response.status} - ${response.body}`);
  }

  const responseData = safeJsonParse(response.body as string) as {
    access_token: string;
    refresh_token: string;
    user: Record<string, unknown>;
  } | null;

  if (!responseData || !responseData.access_token) {
    const emailInfo = email ? ` for ${email}` : '';
    throw new Error(`Magic link token exchange returned invalid data${emailInfo}`);
  }

  return responseData;
}

/**
 * Create authenticated headers for user requests (not admin)
 * Uses anonymous key to respect RLS policies
 */
export function createUserAuthHeaders(accessToken: string, anonKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
    apikey: anonKey
  };
}

/**
 * Generate a unique test run prefix for naming test resources
 */
export function generateTestRunPrefix(testType: string = "k6"): string {
  return `${testType}-${Date.now()}`;
}

/**
 * Make an authenticated request as a student user (respects RLS policies)
 */
export function makeAuthenticatedStudentRequest(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  endpoint: string,
  accessToken: string,
  anonKey: string,
  config: SupabaseConfig,
  data: Record<string, unknown> | null = null
): SupabaseApiResponse {
  const headers = createUserAuthHeaders(accessToken, anonKey);
  
  const url = `${config.url}/rest/v1/${endpoint}`;
  const body = data ? JSON.stringify(data) : null;

  let response;
  switch (method) {
    case "GET":
      response = http.get(url, { headers });
      break;
    case "POST":
      response = http.post(url, body, { headers });
      break;
    case "PATCH":
      response = http.patch(url, body, { headers });
      break;
    case "DELETE":
      response = http.del(url, body, { headers });
      break;
    default:
      throw new Error(`Unsupported HTTP method: ${method}`);
  }

  return {
    status: response.status,
    body: response.body as string | null,
    data: safeJsonParse(response.body as string | null)
  };
}

/**
 * Read all class data for a student - simulates loading a class dashboard
 * Throws an error immediately if any table read fails
 */
export function readAllClassData(
  classId: number,
  userId: string,
  accessToken: string,
  anonKey: string,
  config: SupabaseConfig
): Record<string, SupabaseApiResponse> {
  const results: Record<string, SupabaseApiResponse> = {};

  // Helper function to check response and throw error if failed
  function checkResponseOrThrow(response: SupabaseApiResponse, tableName: string): void {
    if (response.status !== 200 && response.status !== 206) { // 206 for partial content/pagination
      throw new Error(`Failed to read ${tableName}: ${response.status} - ${response.body}`);
    }
  }

  // Read help requests for the class
  results.help_requests = makeAuthenticatedStudentRequest(
    "GET",
    `help_requests?class_id=eq.${classId}&select=*`,
    accessToken,
    anonKey,
    config
  );
  checkResponseOrThrow(results.help_requests, "help_requests");

  // Read help request messages
  results.help_request_messages = makeAuthenticatedStudentRequest(
    "GET",
    `help_request_messages?help_request_id.in.(${getHelpRequestIds(results.help_requests)})&select=*`,
    accessToken,
    anonKey,
    config
  );
  checkResponseOrThrow(results.help_request_messages, "help_request_messages");

  // Read discussion threads
  results.discussion_threads = makeAuthenticatedStudentRequest(
    "GET",
    `discussion_threads?root_class_id=eq.${classId}&select=*`,
    accessToken,
    anonKey,
    config
  );
  checkResponseOrThrow(results.discussion_threads, "discussion_threads");

  // Read discussion thread read status
  results.discussion_thread_read_status = makeAuthenticatedStudentRequest(
    "GET",
    `discussion_thread_read_status?user_id=eq.${userId}&select=*`,
    accessToken,
    anonKey,
    config
  );
  checkResponseOrThrow(results.discussion_thread_read_status, "discussion_thread_read_status");

  // Read discussion thread watchers
  results.discussion_thread_watchers = makeAuthenticatedStudentRequest(
    "GET",
    `discussion_thread_watchers?user_id=eq.${userId}&select=*`,
    accessToken,
    anonKey,
    config
  );
  checkResponseOrThrow(results.discussion_thread_watchers, "discussion_thread_watchers");

  // Read submissions for the class
  results.submissions = makeAuthenticatedStudentRequest(
    "GET",
    `submissions?class_id=eq.${classId}&select=*`,
    accessToken,
    anonKey,
    config
  );
  checkResponseOrThrow(results.submissions, "submissions");

  // Read submission comments
  results.submission_comments = makeAuthenticatedStudentRequest(
    "GET",
    `submission_comments?submission_id.in.(${getSubmissionIds(results.submissions)})&select=*`,
    accessToken,
    anonKey,
    config
  );
  checkResponseOrThrow(results.submission_comments, "submission_comments");

  // Read submission file comments
  results.submission_file_comments = makeAuthenticatedStudentRequest(
    "GET",
    `submission_file_comments?submission_id.in.(${getSubmissionIds(results.submissions)})&select=*`,
    accessToken,
    anonKey,
    config
  );
  checkResponseOrThrow(results.submission_file_comments, "submission_file_comments");

  // Read submission artifact comments
  results.submission_artifact_comments = makeAuthenticatedStudentRequest(
    "GET",
    `submission_artifact_comments?submission_id.in.(${getSubmissionIds(results.submissions)})&select=*`,
    accessToken,
    anonKey,
    config
  );
  checkResponseOrThrow(results.submission_artifact_comments, "submission_artifact_comments");

  // Read submission reviews
  results.submission_reviews = makeAuthenticatedStudentRequest(
    "GET",
    `submission_reviews?submission_id.in.(${getSubmissionIds(results.submissions)})&select=*`,
    accessToken,
    anonKey,
    config
  );
  checkResponseOrThrow(results.submission_reviews, "submission_reviews");

  // Read regrade request comments
  results.regrade_request_comments = makeAuthenticatedStudentRequest(
    "GET",
    `submission_regrade_request_comments?submission_id.in.(${getSubmissionIds(results.submissions)})&select=*`,
    accessToken,
    anonKey,
    config
  );
  checkResponseOrThrow(results.regrade_request_comments, "submission_regrade_request_comments");

  // Read profiles for the class
  results.profiles = makeAuthenticatedStudentRequest(
    "GET",
    `profiles?class_id=eq.${classId}&select=*`,
    accessToken,
    anonKey,
    config
  );
  checkResponseOrThrow(results.profiles, "profiles");

  // Read user roles for the class
  results.user_roles = makeAuthenticatedStudentRequest(
    "GET",
    `user_roles?class_id=eq.${classId}&select=*`,
    accessToken,
    anonKey,
    config
  );
  checkResponseOrThrow(results.user_roles, "user_roles");

  // Read gradebook columns
  results.gradebook_columns = makeAuthenticatedStudentRequest(
    "GET",
    `gradebook_columns?class_id=eq.${classId}&select=*`,
    accessToken,
    anonKey,
    config
  );
  checkResponseOrThrow(results.gradebook_columns, "gradebook_columns");

  // Read gradebook column student data
  results.gradebook_column_students = makeAuthenticatedStudentRequest(
    "GET",
    `gradebook_column_students?class_id=eq.${classId}&select=*`,
    accessToken,
    anonKey,
    config
  );
  checkResponseOrThrow(results.gradebook_column_students, "gradebook_column_students");

  // Read tags for the class
  results.tags = makeAuthenticatedStudentRequest(
    "GET",
    `tags?class_id=eq.${classId}&select=*`,
    accessToken,
    anonKey,
    config
  );
  checkResponseOrThrow(results.tags, "tags");

  // Read lab sections
  results.lab_sections = makeAuthenticatedStudentRequest(
    "GET",
    `lab_sections?class_id=eq.${classId}&select=*`,
    accessToken,
    anonKey,
    config
  );
  checkResponseOrThrow(results.lab_sections, "lab_sections");

  // Read class sections
  results.class_sections = makeAuthenticatedStudentRequest(
    "GET",
    `class_sections?class_id=eq.${classId}&select=*`,
    accessToken,
    anonKey,
    config
  );
  checkResponseOrThrow(results.class_sections, "class_sections");

  // Read lab section meetings
  results.lab_section_meetings = makeAuthenticatedStudentRequest(
    "GET",
    `lab_section_meetings?lab_section_id.in.(${getLabSectionIds(results.lab_sections)})&select=*`,
    accessToken,
    anonKey,
    config
  );
  checkResponseOrThrow(results.lab_section_meetings, "lab_section_meetings");

  return results;
}

/**
 * Read all class data using parallel HTTP requests for better performance
 * Groups independent requests together while maintaining dependencies
 */
export function readAllClassDataParallel(
  classId: number,
  userId: string,
  accessToken: string,
  anonKey: string,
  config: SupabaseConfig
): Record<string, SupabaseApiResponse> {
  const results: Record<string, SupabaseApiResponse> = {};

  // Helper function to check response and throw error if failed
  function checkResponseOrThrow(response: SupabaseApiResponse, tableName: string): void {
    if (response.status !== 200 && response.status !== 206) { // 206 for partial content/pagination
      throw new Error(`Failed to read ${tableName}: ${response.status} - ${response.body}`);
    }
  }

  // Helper function to create authenticated request parameters for batch
  function createBatchRequest(endpoint: string): [string, string, null, { headers: Record<string, string> }] {
    return [
      'GET',
      `${config.url}/rest/v1/${endpoint}`,
      null,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'apikey': anonKey,
          'Content-Type': 'application/json'
        }
      }
    ];
  }

  const independentRequests = {
    help_requests: createBatchRequest(`help_requests?class_id=eq.${classId}&select=*&limit=1000`),
    discussion_threads: createBatchRequest(`discussion_threads?root_class_id=eq.${classId}&select=*&limit=1000`),
    discussion_thread_read_status: createBatchRequest(`discussion_thread_read_status?user_id=eq.${userId}&select=*&limit=1000`),
    discussion_thread_watchers: createBatchRequest(`discussion_thread_watchers?user_id=eq.${userId}&select=*&limit=1000`),
    submissions: createBatchRequest(`submissions?class_id=eq.${classId}&select=*&limit=1000`),
    profiles: createBatchRequest(`profiles?class_id=eq.${classId}&select=*&limit=1000`),
    user_roles: createBatchRequest(`user_roles?class_id=eq.${classId}&select=*&limit=1000`),
    gradebook_columns: createBatchRequest(`gradebook_columns?class_id=eq.${classId}&select=*&limit=1000`),
    gradebook_column_students: createBatchRequest(`gradebook_column_students?class_id=eq.${classId}&select=*&limit=1000`),
    tags: createBatchRequest(`tags?class_id=eq.${classId}&select=*&limit=1000`),
    lab_sections: createBatchRequest(`lab_sections?class_id=eq.${classId}&select=*&limit=1000`),
    class_sections: createBatchRequest(`class_sections?class_id=eq.${classId}&select=*&limit=1000`),
    help_request_messages: createBatchRequest(`help_request_messages?class_id=eq.${classId}&select=*&limit=1000`),
    submission_comments: createBatchRequest(`submission_comments?class_id=eq.${classId}&select=*&limit=1000`),
    submission_file_comments: createBatchRequest(`submission_file_comments?class_id=eq.${classId}&select=*&limit=1000`),
    submission_artifact_comments: createBatchRequest(`submission_artifact_comments?class_id=eq.${classId}&select=*&limit=1000`),
    submission_reviews: createBatchRequest(`submission_reviews?class_id=eq.${classId}&select=*&limit=1000`),
    regrade_request_comments: createBatchRequest(`submission_regrade_request_comments?class_id=eq.${classId}&select=*&limit=1000`),
    lab_section_meetings: createBatchRequest(`lab_section_meetings?class_id=eq.${classId}&select=*&limit=1000`)
  };

  // Execute all independent requests in parallel
  const batchResponses = http.batch(independentRequests);

  // Process batch responses and validate them
  for (const [tableName, response] of Object.entries(batchResponses)) {
    const bodyString = response.body ? (typeof response.body === 'string' ? response.body : response.body.toString()) : null;
    const apiResponse: SupabaseApiResponse = {
      status: response.status,
      body: bodyString,
      data: response.status === 200 || response.status === 206 ? JSON.parse(bodyString || '[]') : null
    };
    results[tableName] = apiResponse;
    checkResponseOrThrow(apiResponse, tableName);
  }

  return results;
}

/**
 * Helper function to extract help request IDs from response
 */
function getHelpRequestIds(response: SupabaseApiResponse): string {
  if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
    return "0"; // Return dummy ID if no data
  }
  return response.data.map((item: Record<string, unknown>) => item.id).join(",");
}

/**
 * Helper function to extract submission IDs from response
 */
function getSubmissionIds(response: SupabaseApiResponse): string {
  if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
    return "0"; // Return dummy ID if no data
  }
  return response.data.map((item: Record<string, unknown>) => item.id).join(",");
}

/**
 * Helper function to extract lab section IDs from response
 */
function getLabSectionIds(response: SupabaseApiResponse): string {
  if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
    return "0"; // Return dummy ID if no data
  }
  return response.data.map((item: Record<string, unknown>) => item.id).join(",");
}

/**
 * Discover existing students in a class
 */
export function discoverExistingStudents(classId: number, config: SupabaseConfig): StudentData[] {
  console.log(`🔍 Discovering existing students in class ${classId}...`);

  // Get user roles for students in the class
  const userRolesResponse = makeSupabaseRequest(
    "GET",
    `user_roles?class_id=eq.${classId}&role=eq.student&select=user_id,private_profile_id,public_profile_id&limit=1000`,
    null,
    config
  );

  if (userRolesResponse.status !== 200) {
    throw new Error(`Failed to get student user roles: ${userRolesResponse.status} ${userRolesResponse.body}`);
  }

  const userRoles = userRolesResponse.data as Array<{
    user_id: string;
    private_profile_id: string;
    public_profile_id: string;
  }>;

  if (!Array.isArray(userRoles) || userRoles.length === 0) {
    throw new Error(`No students found in class ${classId}`);
  }

  console.log(`📊 Found ${userRoles.length} students in class ${classId}`);

  // Get auth users to find emails
  const students: StudentData[] = [];
  
  for (let i = 0; i < Math.min(userRoles.length, 10); i++) { // Limit to 50 students for performance
    const userRole = userRoles[i];
    
    try {
      // Get user email from auth.users
      const authHeaders = createAuthHeaders(config.serviceRoleKey);
      const userResponse = http.get(`${config.url}/auth/v1/admin/users/${userRole.user_id}`, {
        headers: {
          Authorization: authHeaders.Authorization,
          "Content-Type": authHeaders["Content-Type"],
          apikey: authHeaders.apikey
        }
      });

      if (userResponse.status === 200) {
        const userData = safeJsonParse(userResponse.body as string) as { email: string } | null;
        if (userData && userData.email) {
          // Generate magic link for this existing user
          const magicLinkData = generateMagicLink(userData.email, config);
          
          // Immediately exchange magic link for access token (single-use tokens)
          const authData = exchangeMagicLinkForAccessToken(magicLinkData.hashed_token, config, userData.email);
          
          students.push({
            id: `existing-student-${i + 1}`,
            profile_id: userRole.private_profile_id,
            email: userData.email,
            user_id: userRole.user_id,
            public_profile_id: userRole.public_profile_id,
            private_profile_id: userRole.private_profile_id,
            magic_link: magicLinkData,
            access_token: authData.access_token,
            refresh_token: authData.refresh_token
          });
        }
      }
    } catch (error) {
      console.log(`⚠️ Failed to get data for user ${userRole.user_id}: ${error}`);
    }
  }

  console.log(`✅ Successfully prepared ${students.length} students for testing`);
  return students;
}

/**
 * Discover existing assignments in a class
 */
export function discoverExistingAssignments(classId: number, config: SupabaseConfig): Array<{ id: number; title: string; due_date: string }> {
  console.log(`🔍 Discovering existing assignments in class ${classId}...`);

  // Only select assignments with due dates in the future
  const now = new Date().toISOString();
  const assignmentsResponse = makeSupabaseRequest(
    "GET",
    `assignments?class_id=eq.${classId}&due_date=gt.${now}&select=id,title,due_date&limit=1000`,
    null,
    config
  );

  if (assignmentsResponse.status !== 200) {
    throw new Error(`Failed to get assignments: ${assignmentsResponse.status} ${assignmentsResponse.body}`);
  }

  const assignments = assignmentsResponse.data as Array<{ id: number; title: string; due_date: string }>;

  if (!Array.isArray(assignments)) {
    throw new Error(`Invalid assignments response: expected array, got ${typeof assignments}`);
  }

  console.log(`📊 Found ${assignments.length} future assignments in class ${classId}`);
  if (assignments.length > 0) {
    console.log(`📅 Assignment due dates: ${assignments.map(a => `${a.title} (${new Date(a.due_date).toLocaleDateString()})`).join(', ')}`);
  }
  return assignments;
}

/**
 * Validate that a class exists and get basic info
 */
export function validateExistingClass(classId: number, config: SupabaseConfig): { id: number; name: string; slug: string } {
  console.log(`🔍 Validating class ${classId} exists...`);

  const classResponse = makeSupabaseRequest(
    "GET",
    `classes?id=eq.${classId}&select=id,name,slug`,
    null,
    config
  );

  if (classResponse.status !== 200) {
    throw new Error(`Failed to get class: ${classResponse.status} ${classResponse.body}`);
  }

  const classes = classResponse.data as Array<{ id: number; name: string; slug: string }>;

  if (!Array.isArray(classes) || classes.length === 0) {
    throw new Error(`Class ${classId} not found`);
  }

  const classData = classes[0];
  console.log(`✅ Found class: ${classData.name} (${classData.slug})`);
  return classData;
}

/**
 * Discover existing repositories and create missing ones for student-assignment pairs
 */
export function discoverAndCreateRepositories(
  classId: number,
  students: StudentData[],
  assignments: Array<{ id: number; title: string; due_date?: string; minutes_due_after_lab?: number | null }>,
  testRunPrefix: string,
  config: SupabaseConfig
): RepositoryData[] {
  console.log(`🔍 Discovering existing repositories for class ${classId}...`);

  // Get all existing repositories for this class with current assignment due dates
  const existingReposResponse = makeSupabaseRequest(
    "GET",
    `repositories?class_id=eq.${classId}&select=id,repository,assignment_id,profile_id,assignments(id,title,due_date,minutes_due_after_lab)`,
    null,
    config
  );

  if (existingReposResponse.status !== 200) {
    throw new Error(`Failed to get existing repositories: ${existingReposResponse.status} ${existingReposResponse.body}`);
  }

  const existingRepos = existingReposResponse.data as Array<{
    id: number;
    repository: string;
    assignment_id: number;
    profile_id: string;
    assignments: {
      id: number;
      title: string;
      due_date: string | null;
      minutes_due_after_lab: number | null;
    };
  }>;

  console.log(`📊 Found ${existingRepos.length} existing repositories`);

  // Create a map of existing repositories by assignment_id + profile_id
  const existingRepoMap = new Map<string, { id: number; repository: string; assignment: { id: number; title: string; due_date?: string, minutes_due_after_lab: number | null } }>();
  existingRepos.forEach(repo => {
    const key = `${repo.assignment_id}-${repo.profile_id}`;
    existingRepoMap.set(key, { 
      id: repo.id, 
      repository: repo.repository,
      assignment: {
        id: repo.assignments.id,
        title: repo.assignments.title,
        due_date: repo.assignments.due_date || undefined,
        minutes_due_after_lab: repo.assignments.minutes_due_after_lab || null
      }
    });
  });

  const repositories: RepositoryData[] = [];
  let createdCount = 0;
  let existingCount = 0;

  // Check each student-assignment pair
  for (const student of students) {
    for (const assignment of assignments) {
      const key = `${assignment.id}-${student.private_profile_id}`;
      const existingRepo = existingRepoMap.get(key);

      if (existingRepo) {
        // Repository exists, use it with the current assignment data from the database
        repositories.push({
          id: existingRepo.id,
          name: existingRepo.repository,
          student,
          assignment: existingRepo.assignment
        });
        existingCount++;
      } else {
        // Repository doesn't exist, create it
        try {
          const assignmentWithMinutes = {
            ...assignment,
            minutes_due_after_lab: assignment.minutes_due_after_lab || null
          };
          const repositoryData = createTestRepository(student, assignmentWithMinutes, classId, testRunPrefix, config);
          repositories.push(repositoryData);
          createdCount++;
        } catch (error) {
          console.log(`❌ Failed to create repository for student ${student.id}, assignment ${assignment.id}: ${error}`);
        }
      }
    }
  }

  console.log(`✅ Repository discovery complete:`);
  console.log(`   - Existing repositories: ${existingCount}`);
  console.log(`   - Created repositories: ${createdCount}`);
  console.log(`   - Total repositories: ${repositories.length}`);

  return repositories;
}

/**
 * Create a submission for a student (extracted from submissions-api.ts)
 */
export function createStudentSubmission(
  classId: number,
  studentData: StudentData,
  repositories: RepositoryData[],
  config: SupabaseConfig,
  endToEndSecret: string = "not-a-secret"
): SupabaseApiResponse {
  // Find repositories for this student with assignments that are still accepting submissions
  const now = new Date();
  // console.log(`🔍 Filtering repositories for student ${studentData.email} at ${now.toISOString()}`);
  
  const studentRepositories = repositories.filter(repo => {
    if (repo.student.user_id !== studentData.user_id) return false;
    
    // Check if assignment has a due_date and if it's in the future
    const assignment = repo.assignment as { due_date?: string, minutes_due_after_lab: number | null};
    // console.log(`📋 Checking assignment ${assignment.id}: ${assignment.title}, due_date: ${assignment.due_date || 'undefined'}`);
    
    if (assignment.due_date) {
      const dueDate = new Date(assignment.due_date);
      const isAccepting = dueDate > now && assignment.minutes_due_after_lab === null;
      // console.log(`📅 Due: ${dueDate.toISOString()}, accepting: ${isAccepting}`);
      return isAccepting;
    }
    
    // If no due_date, assume it's still accepting submissions
    console.log(`📅 No due date, assuming accepting submissions`);
    return true;
  });
  
  if (studentRepositories.length === 0) {
    throw new Error(`No repositories found for student ${studentData.id} with assignments accepting submissions`);
  }

  // Pick a random repository for this student (from assignments still accepting submissions)
  const randomRepository = studentRepositories[Math.floor(Math.random() * studentRepositories.length)];
  const repository = randomRepository.name;
  const repository_id = randomRepository.id;
  
  const assignment = randomRepository.assignment as { id: number; title: string; due_date?: string, minutes_due_after_lab: number | null };

  // Generate random SHA
  const sha = `HEAD-${Math.random().toString(36).substring(2, 15)}`;

  // Create repository check run
  createRepositoryCheckRun(classId, repository_id, sha, config);

  // Create submission via edge function
  const submissionResponse = createSubmission(repository, sha, config, endToEndSecret);

  // Validate submission creation
  if (submissionResponse.status !== 200) {
    throw new Error(`Failed to create submission: ${submissionResponse.status} - ${submissionResponse.body}`);
  }

  // Validate that we got back submission data with an ID
  if (!submissionResponse.data || typeof submissionResponse.data !== 'object') {
    throw new Error(`Submission created but no data returned: ${submissionResponse.body}`);
  }

  const submissionData = submissionResponse.data as Record<string, unknown>;
  if (!submissionData.submission_id) {
    throw new Error(`Submission created but no submission_id returned. Your asisgnment id was ${assignment.id}: ${JSON.stringify(submissionData)}`);
  }

  // console.log(`✅ Created submission ID: ${submissionData.submission_id}`);
  return submissionResponse;
}

/**
 * Create help request messages for existing help requests
 */
export function createHelpRequestMessages(
  classId: number,
  studentData: StudentData,
  accessToken: string,
  anonKey: string,
  config: SupabaseConfig,
  count: number = 5
): SupabaseApiResponse[] {
  // First, get existing help requests for this class
  const helpRequestsResponse = makeAuthenticatedStudentRequest(
    "GET",
    `help_requests?class_id=eq.${classId}&select=id&limit=10`,
    accessToken,
    anonKey,
    config
  );

  if (helpRequestsResponse.status !== 200 || !Array.isArray(helpRequestsResponse.data) || helpRequestsResponse.data.length === 0) {
    throw new Error(`No help requests found for class ${classId}`);
  }

  const helpRequests = helpRequestsResponse.data as Array<{ id: number }>;
  const results: SupabaseApiResponse[] = [];

  for (let i = 0; i < count; i++) {
    // Pick a random help request
    const randomHelpRequest = helpRequests[Math.floor(Math.random() * helpRequests.length)];
    
    const messagePayload = {
      help_request_id: randomHelpRequest.id,
      class_id: classId,
      author: studentData.private_profile_id,
      message: `Performance test message ${i + 1} from ${studentData.email} at ${new Date().toISOString()}`,
      instructors_only: false
    };

    const response = makeAuthenticatedStudentRequest(
      "POST",
      "help_request_messages",
      accessToken,
      anonKey,
      config,
      messagePayload
    );

    results.push(response);

    if (response.status !== 201) {
      throw new Error(`Failed to create help request message: ${response.status} - ${response.body}`);
    }

    // Validate that we got back the inserted data with an ID
    if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
      throw new Error(`Help request message created but no data returned: ${response.body}`);
    }

    const insertedMessage = response.data[0] as Record<string, unknown>;
    if (!insertedMessage.id) {
      throw new Error(`Help request message created but no ID returned: ${JSON.stringify(insertedMessage)}`);
    }

  }

  return results;
}

/**
 * Create discussion thread replies for existing discussion threads
 */
export function createDiscussionThreadReply(
  classId: number,
  studentData: StudentData,
  accessToken: string,
  anonKey: string,
  config: SupabaseConfig
): SupabaseApiResponse {
  // First, get existing discussion threads for this class (root threads only)
  const discussionThreadsResponse = makeAuthenticatedStudentRequest(
    "GET",
    `discussion_threads?root_class_id=eq.${classId}&select=id,root,topic_id&limit=10`,
    accessToken,
    anonKey,
    config
  );

  if (discussionThreadsResponse.status !== 200 || !Array.isArray(discussionThreadsResponse.data) || discussionThreadsResponse.data.length === 0) {
    throw new Error(`No discussion threads found for class ${classId}`);
  }

  const discussionThreads = discussionThreadsResponse.data as Array<{ id: number; root: number; topic_id: number }>;
  
  // Pick a random discussion thread to reply to
  const randomThread = discussionThreads[Math.floor(Math.random() * discussionThreads.length)];
  
  const replyPayload = {
    class_id: classId,
    root_class_id: classId,
    author: studentData.public_profile_id,
    parent: randomThread.id,
    root: randomThread.root || randomThread.id, // Use the thread's root, or itself if it's a root thread
    subject: `Re: Performance test reply`,
    body: `Performance test reply from ${studentData.email} at ${new Date().toISOString()}`,
    instructors_only: false,
    is_question: false,
    draft: false,
    topic_id: randomThread.topic_id // Use the same topic as the parent thread
  };

  const response = makeAuthenticatedStudentRequest(
    "POST",
    "discussion_threads",
    accessToken,
    anonKey,
    config,
    replyPayload
  );

  if (response.status !== 201) {
    throw new Error(`Failed to create discussion thread reply: ${response.status} - ${response.body}`);
  }

  // Validate that we got back the inserted data with an ID
  if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
    throw new Error(`Discussion thread reply created but no data returned: ${response.body}`);
  }

  const insertedReply = response.data[0] as Record<string, unknown>;
  if (!insertedReply.id) {
    throw new Error(`Discussion thread reply created but no ID returned: ${JSON.stringify(insertedReply)}`);
  }

  // console.log(`✅ Created discussion thread reply ID: ${insertedReply.id}`);
  return response;
}

/**
 * Perform READ ONLY operations for a student in a class
 * This focuses purely on data loading performance without any writes
 */
export function performReadOnlyOperations(
  classId: number,
  studentData: StudentData,
  accessToken: string,
  anonKey: string,
  config: SupabaseConfig
): {
  readResults: Record<string, SupabaseApiResponse>;
  timings: {
    readDuration: number;
  };
} {
  // Read all class data (parallel by default, sequential if USE_SEQUENTIAL_READS=true)
  const readStart = Date.now();
  const useSequential = __ENV.USE_SEQUENTIAL_READS === 'true';
  const readResults = useSequential 
    ? readAllClassData(classId, studentData.user_id, accessToken, anonKey, config)
    : readAllClassDataParallel(classId, studentData.user_id, accessToken, anonKey, config);
  const readDuration = Date.now() - readStart;

  const timings = {
    readDuration
  };

  return { readResults, timings };
}

/**
 * Perform WRITE ONLY operations for a student in a class
 * Creates 100 of each type: discussion replies, help request messages, and submissions
 */
export function performWriteOnlyOperations(
  classId: number,
  studentData: StudentData,
  repositories: RepositoryData[],
  accessToken: string,
  anonKey: string,
  config: SupabaseConfig,
  endToEndSecret: string = "not-a-secret"
): {
  writeResults: {
    helpRequestMessages: SupabaseApiResponse[];
    discussionReplies: SupabaseApiResponse[];
    submissions: SupabaseApiResponse[];
  };
  timings: {
    helpRequestMessagesDuration: number;
    discussionRepliesDuration: number;
    submissionsDuration: number;
    totalWriteDuration: number;
  };
} {
  const totalWriteStart = Date.now();

  // Create 100 help request messages
  const helpRequestStart = Date.now();
  const helpRequestMessages = createHelpRequestMessages(classId, studentData, accessToken, anonKey, config, 100);
  const helpRequestMessagesDuration = Date.now() - helpRequestStart;

  // Create 100 discussion thread replies
  const discussionStart = Date.now();
  const discussionReplies: SupabaseApiResponse[] = [];
  for (let i = 0; i < 100; i++) {
    try {
      const reply = createDiscussionThreadReply(classId, studentData, accessToken, anonKey, config);
      discussionReplies.push(reply);
    } catch (error) {
      console.error(`❌ Failed to create discussion reply ${i + 1}: ${error}`);
      // Add a failed response to maintain count
      discussionReplies.push({
        status: 500,
        body: `Error creating discussion reply: ${error}`,
        data: null
      });
    }
  }
  const discussionRepliesDuration = Date.now() - discussionStart;

  // Create 100 submissions
  const submissionStart = Date.now();
  const submissions: SupabaseApiResponse[] = [];
  for (let i = 0; i < 100; i++) {
    try {
      const submission = createStudentSubmission(classId, studentData, repositories, config, endToEndSecret);
      submissions.push(submission);
    } catch (error) {
      console.error(`❌ Failed to create submission ${i + 1}: ${error}`);
      // Add a failed response to maintain count
      submissions.push({
        status: 500,
        body: `Error creating submission: ${error}`,
        data: null
      });
    }
  }
  const submissionsDuration = Date.now() - submissionStart;

  const totalWriteDuration = Date.now() - totalWriteStart;

  const writeResults = {
    helpRequestMessages,
    discussionReplies,
    submissions
  };

  const timings = {
    helpRequestMessagesDuration,
    discussionRepliesDuration,
    submissionsDuration,
    totalWriteDuration
  };

  return { writeResults, timings };
}

/**
 * Perform mixed read/write operations for a student - simulates realistic class activity
 */
export function performMixedClassOperations(
  classId: number,
  studentData: StudentData,
  repositories: RepositoryData[],
  accessToken: string,
  anonKey: string,
  config: SupabaseConfig,
  endToEndSecret: string = "not-a-secret"
): {
  readResults: Record<string, SupabaseApiResponse>;
  writeResults: {
    helpRequestMessages: SupabaseApiResponse[];
    discussionReply: SupabaseApiResponse;
    submission: SupabaseApiResponse;
  };
  timings: {
    readDuration: number;
    helpRequestMessagesDuration: number;
    discussionReplyDuration: number;
    submissionDuration: number;
  };
} {
  // Step 1: Read all class data (parallel by default, sequential if USE_SEQUENTIAL_READS=true)
  const readStart = Date.now();
  const useSequential = __ENV.USE_SEQUENTIAL_READS === 'true';
  const readResults = useSequential 
    ? readAllClassData(classId, studentData.user_id, accessToken, anonKey, config)
    : readAllClassDataParallel(classId, studentData.user_id, accessToken, anonKey, config);
  const readDuration = Date.now() - readStart;

  // Step 2: Perform write operations with individual timing
  const helpRequestStart = Date.now();
  const helpRequestMessages = createHelpRequestMessages(classId, studentData, accessToken, anonKey, config, 5);
  const helpRequestMessagesDuration = Date.now() - helpRequestStart;

  const discussionStart = Date.now();
  const discussionReply = createDiscussionThreadReply(classId, studentData, accessToken, anonKey, config);
  const discussionReplyDuration = Date.now() - discussionStart;

  const submissionStart = Date.now();
  const submission = createStudentSubmission(classId, studentData, repositories, config, endToEndSecret);
  const submissionDuration = Date.now() - submissionStart;

  const writeResults = {
    helpRequestMessages,
    discussionReply,
    submission
  };

  const timings = {
    readDuration,
    helpRequestMessagesDuration,
    discussionReplyDuration,
    submissionDuration
  };

  return { readResults, writeResults, timings };
}

/**
 * Cleanup helper - note that actual cleanup should be implemented separately
 */
export function logCleanupInfo(classId: number, testType: string): void {
  console.log(`🧹 ${testType} test completed. Class ID: ${classId}`);
  console.log("Note: Test data cleanup should be handled separately if needed.");
}
