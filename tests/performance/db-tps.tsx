

import { sleep, check } from 'k6';
import { Rate, Counter } from 'k6/metrics';
import { 
  createClass, 
  createUserInClass, 
  insertAssignment, 
  insertSubmissionViaAPI,
  TestingUser,
  getTestRunPrefix
} from '../e2e/TestingUtils';

// Custom metrics
export const submissionRate = new Rate('submission_success_rate');
export const submissionCounter = new Counter('submissions_created');
export const errorCounter = new Counter('submission_errors');

// Test configuration
export const options = {
  scenarios: {
    setup_phase: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '5m',
      tags: { phase: 'setup' },
      exec: 'setupData'
    },
    load_test: {
      executor: 'constant-arrival-rate',
      rate: __ENV.SUBMISSION_RATE ? parseInt(__ENV.SUBMISSION_RATE) : 20, // submissions per second
      timeUnit: '1s',
      duration: __ENV.TEST_DURATION || '10s',
      preAllocatedVUs: 10,
      maxVUs: 50,
      tags: { phase: 'load' },
      exec: 'loadTest',
      startTime: '30s' // Wait for setup to complete
    }
  },
  thresholds: {
    submission_success_rate: ['rate>0.95'], // 95% success rate
    http_req_duration: ['p(95)<2000'], // 95% of requests under 2s
    submission_errors: ['count<10'] // Less than 10 errors total
  }
};

// Global test data storage
let testData: {
  class_id: number;
  instructor: TestingUser;
  students: TestingUser[];
  assignments: Array<{ id: number; title: string }>;
} | null = null;

export async function setupData() {
  console.log('🚀 Starting database performance test setup...');
  
  try {
    // 1. Create a test class
    console.log('📚 Creating test class...');
    const testRunPrefix = getTestRunPrefix();
    const testClass = await createClass({ name: `DB Performance Test ${testRunPrefix}` });
    
    console.log(`✅ Created class: ${testClass.name} (ID: ${testClass.id})`);
    
    // 2. Create 1 instructor
    console.log('👨‍🏫 Creating instructor...');
    const instructor = await createUserInClass({
      role: 'instructor',
      class_id: testClass.id,
      randomSuffix: testRunPrefix
    });
    
    console.log(`✅ Created instructor: ${instructor.email}`);
    
    // 3. Create 10 students
    console.log('👥 Creating 10 students...');
    const students: TestingUser[] = [];
    
    for (let i = 0; i < 10; i++) {
      const student = await createUserInClass({
        role: 'student',
        class_id: testClass.id,
        randomSuffix: `${testRunPrefix}-student-${i}`
      });
      students.push(student);
      console.log(`✅ Created student ${i + 1}/10: ${student.email}`);
    }
    
    // 4. Create 10 assignments
    console.log('📝 Creating 10 assignments...');
    const assignments = [];
    
    for (let i = 0; i < 10; i++) {
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 7 + i); // Stagger due dates
      
      const assignment = await insertAssignment({
        due_date: dueDate.toISOString(),
        class_id: testClass.id,
        allow_not_graded_submissions: true
      });
      
      assignments.push({
        id: assignment.id,
        title: assignment.title
      });
      
      console.log(`✅ Created assignment ${i + 1}/10: ${assignment.title} (ID: ${assignment.id})`);
    }
    
    // Store test data globally for the load test phase
    testData = {
      class_id: testClass.id,
      instructor,
      students,
      assignments
    };
    
    console.log('🎉 Setup completed successfully!');
    console.log(`📊 Test data summary:
    - Class ID: ${testClass.id}
    - Instructor: ${instructor.email}
    - Students: ${students.length}
    - Assignments: ${assignments.length}`);
    
    return testData;
    
  } catch (error) {
    console.error('❌ Setup failed:', error);
    throw error;
  }
}

export async function loadTest() {
  if (!testData) {
    console.error('❌ Test data not available - setup may have failed');
    return;
  }
  
  const { class_id, students, assignments } = testData;
  
  // Randomly select a student and assignment
  const randomStudent = students[Math.floor(Math.random() * students.length)];
  const randomAssignment = assignments[Math.floor(Math.random() * assignments.length)];
  
  const startTime = Date.now();
  
  try {
    // Call insertSubmissionViaAPI with random student/assignment
    const result = await insertSubmissionViaAPI({
      student_profile_id: randomStudent.private_profile_id,
      assignment_id: randomAssignment.id,
      class_id: class_id,
      sha: `test-sha-${Math.random().toString(36).substring(2, 15)}`,
      commit_message: `Performance test submission from ${randomStudent.email}`,
      repositorySuffix: `perf-test-${Date.now()}`
    });
    
    const duration = Date.now() - startTime;
    
    // Record successful submission
    submissionRate.add(true);
    submissionCounter.add(1);
    
    // Validate the result
    const success = check(result, {
      'submission created successfully': (r: unknown) => r && typeof r === 'object' && 'submission_id' in r && (r as { submission_id: number }).submission_id > 0,
      'repository name returned': (r: unknown) => r && typeof r === 'object' && 'repository_name' in r && typeof (r as { repository_name: string }).repository_name === 'string',
      'submission completed under 2s': () => duration < 2000,
    });
    
    if (!success) {
      errorCounter.add(1);
      console.error(`❌ Submission validation failed for student ${randomStudent.email}, assignment ${randomAssignment.id}`);
    }
    
    console.log(`✅ Submission created: ID ${result.submission_id}, Duration: ${duration}ms`);
    
  } catch (error) {
    // Record failed submission
    submissionRate.add(false);
    errorCounter.add(1);
    
    console.error(`❌ Submission failed for student ${randomStudent.email}, assignment ${randomAssignment.id}:`, error);
    
    check(null, {
      'submission did not fail': () => false
    });
  }
}

// Default export for k6 (required by k6 runtime)
// eslint-disable-next-line import/no-anonymous-default-export
export default function(): void {
  // This function runs during the main test phases
  // The actual work is done in setupData() and loadTest()
}

// Teardown function (optional)
export function teardown(data: typeof testData): void {
  if (data && data.class_id) {
    console.log(`🧹 Test completed. Class ID: ${data.class_id}`);
    console.log('Note: Test data cleanup should be handled separately if needed.');
  }
}

// Helper function to validate environment setup
export function validateEnvironment(): void {
  const requiredEnvVars = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'TEST_PASSWORD'
  ];
  
  const missing = requiredEnvVars.filter(env => !__ENV[env]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  
  console.log('✅ Environment validation passed');
}

// Performance test configuration examples:
/*
Usage examples:

1. Basic test (20 submissions/second for 10 seconds):
   k6 run tests/performance/db-tps.tsx

2. Higher load (50 submissions/second for 30 seconds):
   k6 run -e SUBMISSION_RATE=50 -e TEST_DURATION=30s tests/performance/db-tps.tsx

3. Stress test (100 submissions/second for 60 seconds):
   k6 run -e SUBMISSION_RATE=100 -e TEST_DURATION=60s tests/performance/db-tps.tsx

4. Custom test with specific VUs:
   k6 run --vus 20 --duration 30s tests/performance/db-tps.tsx

Environment variables:
- SUBMISSION_RATE: Number of submissions per second (default: 20)
- TEST_DURATION: Duration of the load test (default: 10s)
- SUPABASE_URL: Your Supabase URL
- SUPABASE_SERVICE_ROLE_KEY: Your Supabase service role key
- TEST_PASSWORD: Password for test users
*/
