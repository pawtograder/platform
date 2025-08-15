import { check } from 'k6';
import { Rate, Counter } from 'k6/metrics';
import http from 'k6/http';
import encoding from 'k6/encoding';

// k6 globals
declare const __ENV: Record<string, string>;

function safeJsonParse(body: string | null): any {
  if (!body || body.trim() === '') {
    console.log('⚠️ Empty response body');
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

// Custom metrics
export const submissionRate = new Rate('submission_success_rate');
export const submissionCounter = new Counter('submissions_created');
export const errorCounter = new Counter('submission_errors');

// Test configuration - Use k6's built-in setup/teardown instead of scenarios
export const options = {
  vus: __ENV.SUBMISSION_RATE ? parseInt(__ENV.SUBMISSION_RATE) : 5, // Start with lower load
  duration: __ENV.TEST_DURATION || '30s', // Longer duration for more realistic testing
  thresholds: {
    submission_success_rate: ['rate>0.8'], // More lenient for initial testing
    http_req_duration: ['p(95)<5000'], // More lenient for complex operations
    submission_errors: ['count<20'] // Allow more errors for initial testing
  }
};

// Data type for sharing between k6 phases
type TestData = {
  class_id: number;
  students: Array<{ 
    id: string; 
    profile_id: string; 
    email: string;
    user_id: string;
    public_profile_id: string;
    private_profile_id: string;
  }>;
  assignments: Array<{ id: number; title: string }>;
  repositories: Array<{
    id: number;
    name: string;
    student: { 
      id: string; 
      profile_id: string; 
      email: string;
      user_id: string;
      public_profile_id: string;
      private_profile_id: string;
    };
    assignment: { id: number; title: string };
  }>;
};

export async function setup() {
  console.log('🚀 Starting HTTP-based performance test setup...');
  
  const supabaseUrl = __ENV.SUPABASE_URL;
  const serviceRoleKey = __ENV.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  }
  
  const headers = {
    'Authorization': `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
    'apikey': serviceRoleKey,
    'Prefer': 'return=representation'
  };
  
  try {
    // Create test data using direct HTTP calls to Supabase REST API
    console.log('📚 Creating test class...');
    console.log('🔗 Supabase URL:', supabaseUrl);
    console.log('🔑 Service role key available:', serviceRoleKey ? 'YES' : 'NO');
    
    const testRunPrefix = `http-perf-${Date.now()}`;
    console.log('🏷️ Test run prefix:', testRunPrefix);
    
    // 1. Create class
    console.log('📝 Making POST request to create class...');
    const classResponse = http.post(`${supabaseUrl}/rest/v1/classes`, JSON.stringify({
      name: `HTTP Performance Test ${testRunPrefix}`,
      slug: `http-performance-test-${testRunPrefix}`,
      github_org: 'pawtograder-playground',
      start_date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      end_date: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
      late_tokens_per_student: 10,
      time_zone: 'America/New_York'
    }), { headers });
    
    console.log('📊 Class creation response status:', classResponse.status);
    console.log('📊 Class creation response body:', classResponse.body);
    
    if (classResponse.status !== 201) {
      throw new Error(`Failed to create class: ${classResponse.status} ${classResponse.body}`);
    }
    
    const responseData = safeJsonParse(classResponse.body as string);
    
    // Handle response data
    let classData: any;
    if (responseData && Array.isArray(responseData) && responseData.length > 0) {
      classData = responseData[0];
      console.log('✅ Received real class data from API');
    } else {
      throw new Error('Class creation failed - no data returned from API. Check if Prefer header is working.');
    }
    
    console.log(`✅ Created class: ${classData.name} (ID: ${classData.id})`);
    
    // 2. Create real assignments for performance testing
    console.log('📋 Creating test assignments...');
    const assignments = [];
    for (let i = 0; i < 3; i++) { // Create fewer assignments to reduce setup time
      
      // First create self-review setting (required by assignments table)
      console.log(`📋 Creating self-review setting for assignment ${i + 1}`);
      const selfReviewResponse = http.post(`${supabaseUrl}/rest/v1/assignment_self_review_settings`, JSON.stringify({
        class_id: classData.id,
        enabled: true,
        deadline_offset: 2,
        allow_early: true
      }), { headers });
      
      if (selfReviewResponse.status !== 201) {
        console.log(`❌ Failed to create self-review setting for assignment ${i + 1}: ${selfReviewResponse.status} - ${selfReviewResponse.body}`);
        continue;
      }
      
      const selfReviewData = safeJsonParse(selfReviewResponse.body as string);
      if (!selfReviewData || !Array.isArray(selfReviewData) || selfReviewData.length === 0) {
        console.log(`❌ Self-review setting created but response data is invalid`);
        continue;
      }
      
      const selfReviewSettingId = selfReviewData[0].id;
      console.log(`✅ Created self-review setting ID: ${selfReviewSettingId}`);
      
      // Now create the assignment with the self-review setting ID
      const assignmentResponse = http.post(`${supabaseUrl}/rest/v1/assignments`, JSON.stringify({
        title: `HTTP Performance Test Assignment ${i + 1}`,
        description: `Test assignment ${i + 1} for HTTP performance testing`,
        due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days from now
        template_repo: 'pawtograder-playground/test-e2e-java-handout',
        autograder_points: 100,
        total_points: 100,
        max_late_tokens: 3,
        release_date: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // 1 day ago
        class_id: classData.id,
        slug: `http-perf-assignment-${i + 1}-${testRunPrefix}`,
        group_config: 'individual',
        allow_not_graded_submissions: false,
        self_review_setting_id: selfReviewSettingId
      }), { headers });
      
      console.log(`📝 Assignment ${i + 1} creation response: ${assignmentResponse.status}`);
      console.log(`📝 Assignment ${i + 1} response body: ${assignmentResponse.body}`);
      
      if (assignmentResponse.status === 201) {
        const assignmentData = safeJsonParse(assignmentResponse.body as string);
        if (assignmentData && Array.isArray(assignmentData) && assignmentData.length > 0) {
          const assignmentId = assignmentData[0].id;
          
          // Update autograder config (assignment creation automatically creates autograder record)
          console.log(`🔧 Updating autograder config for assignment ${assignmentId}`);
          const autograderUpdateResponse = http.patch(`${supabaseUrl}/rest/v1/autograder?id=eq.${assignmentId}`, JSON.stringify({
            config: { 
              submissionFiles: { 
                files: ["**/*.java", "**/*.py", "**/*.arr", "**/*.ts"], 
                testFiles: [] 
              } 
            },
            max_submissions_count: null,
            max_submissions_period_secs: null

          }), { headers });
          
          console.log(`🔧 Autograder config update response: ${autograderUpdateResponse.status}`);
          console.log(`🔧 Autograder config update body: ${autograderUpdateResponse.body}`);
          
          if (autograderUpdateResponse.status === 200 || autograderUpdateResponse.status === 204) {
            assignments.push({
              id: assignmentId,
              title: assignmentData[0].title
            });
            console.log(`✅ Created assignment ID: ${assignmentId} with updated autograder config`);
          } else {
            console.log(`⚠️ Failed to update autograder config for assignment ${assignmentId}: ${autograderUpdateResponse.status} - ${autograderUpdateResponse.body}`);
            // Still add the assignment even if autograder update fails, for testing purposes
            assignments.push({
              id: assignmentId,
              title: assignmentData[0].title
            });
            console.log(`⚠️ Added assignment ${assignmentId} without updated autograder config`);
          }
        } else {
          console.log(`❌ Assignment ${i + 1} created but response data is invalid: ${assignmentResponse.body}`);
        }
      } else {
        console.log(`❌ Failed to create assignment ${i + 1}: ${assignmentResponse.status} - ${assignmentResponse.body}`);
      }
    }
    
    // 3. Create real students (using HTTP calls to Supabase)
    console.log('👥 Creating real students...');
    const students = [];
    const password = process.env.TEST_PASSWORD || 'change-it';
    const workerIndex = process.env.TEST_WORKER_INDEX || 'k6-worker';
    
    for (let i = 0; i < 5; i++) { // Create fewer students to reduce load
      const studentNumber = i + 1;
      const email = `student-${testRunPrefix}-${workerIndex}-${studentNumber}@pawtograder.net`;
      const privateName = `Student #${studentNumber} Test`;
      const publicName = `Pseudonym #${studentNumber}`;
      
      console.log(`👤 Creating student ${studentNumber}: ${email}`);
      
      // Step 3a: Create auth user
      const createUserResponse = http.post(`${supabaseUrl}/auth/v1/admin/users`, JSON.stringify({
        email: email,
        password: password,
        email_confirm: true
      }), { 
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        }
      });
      
      console.log(`📊 User creation response status: ${createUserResponse.status}`);
      console.log(`📊 User creation response body: ${createUserResponse.body}`);
      
      if (createUserResponse.status !== 200 && createUserResponse.status !== 201) {
        console.log(`⚠️ Failed to create user ${email}: ${createUserResponse.status} - ${createUserResponse.body}`);
        continue;
      }
      
      const userData = safeJsonParse(createUserResponse.body as string);
      if (!userData || !userData.id) {
        console.log(`⚠️ User creation returned invalid data for ${email}`);
        continue;
      }
      
      const userId = userData.id;
      console.log(`✅ Created user ID: ${userId}`);
      
      // Step 3b: Create public profile
      const publicProfileResponse = http.post(`${supabaseUrl}/rest/v1/profiles`, JSON.stringify({
        name: publicName,
        avatar_url: `https://api.dicebear.com/9.x/identicon/svg?seed=test-user-${studentNumber}`,
        class_id: classData.id,
        is_private_profile: false
      }), { headers });
      
      if (publicProfileResponse.status !== 201) {
        console.log(`⚠️ Failed to create public profile for ${email}: ${publicProfileResponse.status} - ${publicProfileResponse.body}`);
        continue;
      }
      
      const publicProfileData = safeJsonParse(publicProfileResponse.body as string);
      if (!publicProfileData || !Array.isArray(publicProfileData) || publicProfileData.length === 0) {
        console.log(`⚠️ Public profile creation returned invalid data for ${email}`);
        continue;
      }
      
      const publicProfileId = publicProfileData[0].id;
      console.log(`✅ Created public profile ID: ${publicProfileId}`);
      
      // Step 3c: Create private profile
      const privateProfileResponse = http.post(`${supabaseUrl}/rest/v1/profiles`, JSON.stringify({
        name: privateName,
        avatar_url: `https://api.dicebear.com/9.x/identicon/svg?seed=test-private-user-${studentNumber}`,
        class_id: classData.id,
        is_private_profile: true
      }), { headers });
      
      if (privateProfileResponse.status !== 201) {
        console.log(`⚠️ Failed to create private profile for ${email}: ${privateProfileResponse.status} - ${privateProfileResponse.body}`);
        continue;
      }
      
      const privateProfileData = safeJsonParse(privateProfileResponse.body as string);
      if (!privateProfileData || !Array.isArray(privateProfileData) || privateProfileData.length === 0) {
        console.log(`⚠️ Private profile creation returned invalid data for ${email}`);
        continue;
      }
      
      const privateProfileId = privateProfileData[0].id;
      console.log(`✅ Created private profile ID: ${privateProfileId}`);
      
      // Step 3d: Create user role (enroll student in class)
      const userRoleResponse = http.post(`${supabaseUrl}/rest/v1/user_roles`, JSON.stringify({
        user_id: userId,
        class_id: classData.id,
        private_profile_id: privateProfileId,
        public_profile_id: publicProfileId,
        role: 'student'
      }), { headers });
      
      if (userRoleResponse.status !== 201) {
        console.log(`⚠️ Failed to create user role for ${email}: ${userRoleResponse.status} - ${userRoleResponse.body}`);
        continue;
      }
      
      console.log(`✅ Enrolled student ${email} in class`);
      
      // Add to students array
      students.push({
        id: `student-${testRunPrefix}-${studentNumber}`,
        profile_id: privateProfileId,
        email: email,
        user_id: userId,
        public_profile_id: publicProfileId,
        private_profile_id: privateProfileId
      });
    }
    
    console.log(`✅ Created ${assignments.length} assignments and ${students.length} real students`);
    
    // 4. Create repositories for each student-assignment pair
    console.log('🏗️ Creating repositories for student-assignment pairs...');
    const repositories = [];
    
    for (const student of students) {
      for (const assignment of assignments) {
        const timestamp = Date.now();
        const studentId = student.id.slice(0, 8);
        const repository = `pawtograder-playground/test-e2e-student-repo-java--${testRunPrefix}-setup-${assignment.id}-${studentId}-${timestamp}`;
        
        console.log(`🏗️ Creating repository: ${repository} for student ${student.id} and assignment ${assignment.id}`);
        
        const repositoryCreateResponse = http.post(`${supabaseUrl}/rest/v1/repositories`, JSON.stringify({
          assignment_id: assignment.id,
          repository: repository,
          class_id: classData.id,
          assignment_group_id: null,
          profile_id: student.private_profile_id,
          synced_handout_sha: "none"
        }), { headers });
        
        if (repositoryCreateResponse.status === 201) {
          const repositoryData = safeJsonParse(repositoryCreateResponse.body as string);
          if (repositoryData && Array.isArray(repositoryData) && repositoryData.length > 0) {
            const repository_id = repositoryData[0].id;
            repositories.push({
              id: repository_id,
              name: repository,
              student: student,
              assignment: assignment
            });
            console.log(`✅ Created repository ID: ${repository_id} for ${student.id} - ${assignment.title}`);
          } else {
            console.log(`⚠️ Repository created but response data is invalid for ${repository}`);
          }
        } else {
          console.log(`❌ Failed to create repository ${repository}: ${repositoryCreateResponse.status} - ${repositoryCreateResponse.body}`);
        }
      }
    }
    
    console.log(`✅ Created ${repositories.length} repositories from ${students.length} students × ${assignments.length} assignments`);
    
    if (assignments.length === 0) {
      throw new Error('No assignments were created successfully - cannot proceed with performance test');
    }
    
    if (repositories.length === 0) {
      throw new Error('No repositories were created successfully - cannot proceed with performance test');
    }
    
    const setupResult: TestData = {
      class_id: classData.id,
      students,
      assignments,
      repositories
    };
    
    console.log('🎉 HTTP setup completed successfully!');
    console.log(`📊 Test data summary:
    - Class ID: ${classData.id}
    - Students: ${students.length}
    - Assignments: ${assignments.length}
    - Repositories: ${repositories.length}`);
    
    return setupResult;
    
  } catch (error) {
    console.error('❌ HTTP setup failed:', JSON.stringify(error, null, 2));
    console.error('❌ Error details:', error);
    console.error('❌ Error message:', error instanceof Error ? error.message : String(error));
    console.error('❌ Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    throw error;
  }
}

// Default export for k6 - this receives data from setup() function
// eslint-disable-next-line import/no-anonymous-default-export
export default function(data: TestData | undefined): void {
  if (!data) {
    console.error('❌ Test data not available - setup may have failed');
    errorCounter.add(1);
    submissionRate.add(false);
    return;
  }
  
  const supabaseUrl = __ENV.SUPABASE_URL;
  const serviceRoleKey = __ENV.SUPABASE_SERVICE_ROLE_KEY;
  const endToEndSecret = __ENV.END_TO_END_SECRET || 'not-a-secret';
  
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable');
    errorCounter.add(1);
    submissionRate.add(false);
    return;
  }
  
  const headers = {
    'Authorization': `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
    'apikey': serviceRoleKey,
    'Prefer': 'return=representation'
  };
  
  const { class_id, repositories } = data;
  
  // Randomly select a pre-created repository (which has associated student and assignment)
  const randomRepository = repositories[Math.floor(Math.random() * repositories.length)];
  const { student: randomStudent, assignment: randomAssignment } = randomRepository;
  
  const startTime = Date.now();
  
  // Declare variables that need to be accessible in catch block
  const repository = randomRepository.name;
  const repository_id = randomRepository.id;
  
  try {
    // Step 1: Use pre-created repository (created during setup)
    
    console.log(`🎯 Using pre-created repository: ${repository} (ID: ${repository_id})`);
    console.log(`👤 Student: ${randomStudent.id}, 📝 Assignment: ${randomAssignment.title} (ID: ${randomAssignment.id})`);
    
    // Step 2: Create repository check run (same as insertSubmissionViaAPI)
    console.log(`🔍 Creating check run for repository ID: ${repository_id}`);
    
    const sha = `HEAD-${Math.random().toString(36).substring(2, 15)}`;
    const checkRunCreateResponse = http.post(`${supabaseUrl}/rest/v1/repository_check_runs`, JSON.stringify({
      class_id: class_id,
      repository_id: repository_id,
      check_run_id: Math.floor(Math.random() * 100000),
      status: "{}",
      sha: sha,
      commit_message: "HTTP performance test submission"
    }), { headers });
    
    console.log(`📊 Check run creation response status: ${checkRunCreateResponse.status}`);
    console.log(`📊 Check run creation response body: ${checkRunCreateResponse.body}`);
    
    if (checkRunCreateResponse.status !== 201) {
      throw new Error(`Failed to create check run: ${checkRunCreateResponse.status} ${checkRunCreateResponse.body}`);
    }
    
    console.log(`✅ Created check run for SHA: ${sha}`);
    
    // Step 3: Create JWT token (same as insertSubmissionViaAPI)
    const payload = {
      repository: repository,
      sha: sha,
      workflow_ref: '.github/workflows/grade.yml-e2e-test',
      run_id: Math.floor(Math.random() * 100000),
      run_attempt: 1
    };
    
    const header = {
      alg: 'RS256',
      typ: 'JWT', 
      kid: endToEndSecret
    };
    
    console.log(`🎫 JWT Header: ${JSON.stringify(header)}`);
    console.log(`🎫 JWT Payload: ${JSON.stringify(payload)}`);
    console.log(`🔑 END_TO_END_SECRET: ${endToEndSecret}`);
    
    // Create JWT token without signature (same as insertSubmissionViaAPI)
    const tokenStr = encoding.b64encode(JSON.stringify(header)) + '.' + encoding.b64encode(JSON.stringify(payload)) + '.';
    
    console.log(`🎫 Created JWT token for submission`);
    
    // Step 3: Call autograder-create-submission edge function
    console.log(`🚀 Calling autograder-create-submission edge function`);
    console.log(`🎫 JWT Token: ${tokenStr.substring(0, 100)}...`);
    console.log(`📡 Endpoint: ${supabaseUrl}/functions/v1/autograder-create-submission`);
    
    const submissionResponse = http.post(`${supabaseUrl}/functions/v1/autograder-create-submission`, null, {
      headers: {
        'Authorization': tokenStr,
        'Content-Type': 'application/json',
      }
    });
    
    const duration = Date.now() - startTime;
    
    console.log(`📊 Submission response status: ${submissionResponse.status}`);
    console.log(`📊 Submission response body: ${submissionResponse.body}`);
    console.log(`📊 Submission response headers: ${JSON.stringify(submissionResponse.headers)}`);
    console.log(`⏱️ Request duration: ${duration}ms`);
    
    // Check if the submission was successful
    const success = submissionResponse.status === 200;
    
    if (success) {
      submissionRate.add(true);
      submissionCounter.add(1);
      
      const submissionData = safeJsonParse(submissionResponse.body as string);
      
      // Validate the result
      const validationSuccess = check(submissionResponse, {
        'submission API responded successfully': (r) => r.status === 200,
        'response time under 2s': () => duration < 2000,
        'response contains submission_id': (r) => {
          const data = safeJsonParse(r.body as string);
          return data && data.submission_id && typeof data.submission_id === 'number';
        }
      });
      
      if (!validationSuccess) {
        errorCounter.add(1);
        console.error(`❌ Submission validation failed for student ${randomStudent.id}, assignment ${randomAssignment.id}`);
        console.error(`❌ Response body: ${submissionResponse.body}`);
      } else {
        const submissionId = submissionData?.submission_id || 'unknown';
        console.log(`✅ Submission created successfully! Submission ID: ${submissionId}, Duration: ${duration}ms, Repository: ${repository}`);
      }
      
    } else {
      // Record failed submission
      submissionRate.add(false);
      errorCounter.add(1);
      
      console.error(`❌ Submission failed for student ${randomStudent.id}, assignment ${randomAssignment.id}`);
      console.error(`❌ HTTP Status: ${submissionResponse.status}`);
      console.error(`❌ Response body: ${submissionResponse.body}`);
      console.error(`❌ Response headers: ${JSON.stringify(submissionResponse.headers)}`);
      console.error(`❌ Repository: ${repository}`);
      console.error(`❌ SHA: ${sha}`);
      console.error(`❌ JWT payload: ${JSON.stringify(payload)}`);
      
      // Try to parse error response
      const errorData = safeJsonParse(submissionResponse.body as string);
      if (errorData) {
        console.error(`❌ Parsed error data: ${JSON.stringify(errorData, null, 2)}`);
      }
      
      check(submissionResponse, {
        'submission did not fail': () => false
      });
    }
    
  } catch (error) {
    // Record failed submission
    submissionRate.add(false);
    errorCounter.add(1);
    
    console.error(`❌ Submission failed for student ${randomStudent.id}, assignment ${randomAssignment.id}`);
    console.error(`❌ Exception thrown: ${error}`);
    console.error(`❌ Error message: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`❌ Error stack: ${error instanceof Error ? error.stack : 'No stack trace'}`);
    
    // Log context information for debugging
    console.error(`❌ Context - Repository: ${repository}`);
    console.error(`❌ Context - Repository ID: ${repository_id}`);
    console.error(`❌ Context - Class ID: ${class_id}`);
    console.error(`❌ Context - Assignment ID: ${randomAssignment.id}`);
    console.error(`❌ Context - Student ID: ${randomStudent.id}`);
    
    check(null, {
      'submission did not fail': () => false
    });
  }
}

// Teardown function
export function teardown(data: TestData | undefined): void {
  if (data && data.class_id) {
    console.log(`🧹 HTTP test completed. Class ID: ${data.class_id}`);
    console.log('Note: Test data cleanup should be handled separately if needed.');
  }
}

/*
HTTP Performance Test for Real Submission Creation

This test replicates the exact same API calls as insertSubmissionViaAPI:
1. Creates repository records in the database
2. Creates repository check runs
3. Signs JWT tokens with END_TO_END_SECRET
4. Calls autograder-create-submission edge function

Usage examples:

1. Basic test (5 VUs for 30 seconds):
   npm run test:k6:http

2. Medium load (10 VUs for 60 seconds):
   k6 run -e SUBMISSION_RATE=10 -e TEST_DURATION=60s dist/k6-tests/db-tps-http.js

3. Higher load (20 VUs for 2 minutes):
   k6 run -e SUBMISSION_RATE=20 -e TEST_DURATION=2m dist/k6-tests/db-tps-http.js

Environment variables required:
- SUPABASE_URL: Your Supabase project URL  
- SUPABASE_SERVICE_ROLE_KEY: Your Supabase service role key
- END_TO_END_SECRET: Secret for JWT authentication (defaults to 'not-a-secret')

What this tests:
- Database performance under submission load
- Edge function performance
- End-to-end submission creation flow
- JWT token validation and processing
*/
