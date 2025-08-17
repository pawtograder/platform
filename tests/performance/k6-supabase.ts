import http from "k6/http";
import encoding from "k6/encoding";

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
}

export interface RepositoryData {
  id: number;
  name: string;
  student: StudentData;
  assignment: { id: number; title: string };
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
  config: SupabaseConfig
): { hashed_token: string; verification_type: string; redirect_to?: string } {
  console.log(`🔗 Generating magic link for: ${email}`);

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

  if (response.status !== 200) {
    throw new Error(`Failed to generate magic link for ${email}: ${response.status} - ${response.body}`);
  }

  const responseData = safeJsonParse(response.body as string) as {
    hashed_token: string;
    verification_type: string;
    redirect_to?: string;
  } | null;

  if (!responseData || !responseData.hashed_token || !responseData.verification_type) {
    console.log(responseData);
    throw new Error(`Magic link generation returned invalid data for ${email}`);
  }

  console.log(`✅ Generated magic link for ${email}`);
  console.log(`   Hashed token: ${responseData.hashed_token}`);
  console.log(`   Verification token: ${responseData.verification_type}`);

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
    due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
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
  console.log(`✅ Created private profile ID: ${privateProfileId}`);

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

  console.log(`✅ Enrolled student ${email} in class`);

  // Step 5: Generate magic link for the student
  const magicLinkData = generateMagicLink(email, config);

  return {
    id: `student-${testRunPrefix}-${studentNumber}`,
    profile_id: privateProfileId,
    email,
    user_id: userId,
    public_profile_id: publicProfileId,
    private_profile_id: privateProfileId,
    magic_link: magicLinkData
  };
}

/**
 * Create a repository for a student-assignment pair
 */
export function createTestRepository(
  student: StudentData,
  assignment: { id: number; title: string },
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
  config: SupabaseConfig
): { access_token: string; refresh_token: string; user: any } {
  console.log(`🔄 Exchanging magic link token for access token...`);

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
    throw new Error(`Failed to exchange magic link token: ${response.status} - ${response.body}`);
  }

  const responseData = safeJsonParse(response.body as string) as {
    access_token: string;
    refresh_token: string;
    user: any;
  } | null;

  if (!responseData || !responseData.access_token) {
    console.log(`Exchange response data:`, responseData);
    throw new Error(`Magic link token exchange returned invalid data`);
  }

  console.log(`✅ Successfully exchanged magic link for access token`);
  console.log(`   Access token: ${responseData.access_token.substring(0, 20)}...`);

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
 * Cleanup helper - note that actual cleanup should be implemented separately
 */
export function logCleanupInfo(classId: number, testType: string): void {
  console.log(`🧹 ${testType} test completed. Class ID: ${classId}`);
  console.log("Note: Test data cleanup should be handled separately if needed.");
}
