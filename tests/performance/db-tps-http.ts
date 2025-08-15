import { check } from "k6";
import {
  getSupabaseConfig,
  createTestClass,
  createTestStudent,
  makeSupabaseRequest,
  createAuthHeaders,
  safeJsonParse,
  generateTestRunPrefix,
  generateMagicLink,
  exchangeMagicLinkForAccessToken,
  createUserAuthHeaders,
  logCleanupInfo,
  type SupabaseConfig,
  type ClassData,
  type StudentData
} from "./k6-supabase.ts";
import http from "k6/http";

// k6 globals
declare const __ENV: Record<string, string>;

// k6 test configuration
export const options = {
  // Run setup only - no actual load testing
  scenarios: {
    setup_only: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "30s"
    }
  },
  thresholds: {
    http_req_duration: ["p(95)<5000"], // 95% of requests should be below 5s
    http_req_failed: ["rate<0.1"] // Error rate should be below 10%
  }
};

export interface TestData {
  config: SupabaseConfig;
  classData: ClassData;
  instructor: InstructorData;
  students: StudentData[];
  testRunPrefix: string;
}

export interface InstructorData {
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

/**
 * Create a test instructor (auth user + profiles + enrollment)
 */
function createTestInstructor(
  classId: number,
  testRunPrefix: string,
  config: SupabaseConfig
): InstructorData {
  const email = `instructor-${testRunPrefix}@pawtograder.net`;
  const privateName = `Instructor Test`;
  const publicName = `Professor Test`;
  const password = __ENV.TEST_PASSWORD || "change-it";

  console.log(`👩‍🏫 Creating instructor: ${email}`);

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
    throw new Error(`Failed to create instructor user ${email}: ${userResponse.status} - ${userResponse.body}`);
  }

  const userData = safeJsonParse(userResponse.body as string) as { id: string } | null;
  if (!userData || !userData.id) {
    throw new Error(`Instructor user creation returned invalid data for ${email}`);
  }

  const userId = userData.id;
  console.log(`✅ Created instructor user ID: ${userId}`);

  // Step 2: Create public profile
  const publicProfilePayload = {
    name: publicName,
    avatar_url: `https://api.dicebear.com/9.x/identicon/svg?seed=instructor-public`,
    class_id: classId,
    is_private_profile: false
  };

  const publicProfileResponse = makeSupabaseRequest("POST", "profiles", publicProfilePayload, config);

  if (publicProfileResponse.status !== 201) {
    throw new Error(`Failed to create instructor public profile for ${email}: ${publicProfileResponse.status}`);
  }

  const publicProfileData = publicProfileResponse.data;
  if (!publicProfileData || !Array.isArray(publicProfileData) || publicProfileData.length === 0) {
    throw new Error(`Instructor public profile creation returned invalid data for ${email}`);
  }

  const publicProfileId = (publicProfileData[0] as { id: string }).id;
  console.log(`✅ Created instructor public profile ID: ${publicProfileId}`);

  // Step 3: Create private profile
  const privateProfilePayload = {
    name: privateName,
    avatar_url: `https://api.dicebear.com/9.x/identicon/svg?seed=instructor-private`,
    class_id: classId,
    is_private_profile: true
  };

  const privateProfileResponse = makeSupabaseRequest("POST", "profiles", privateProfilePayload, config);

  if (privateProfileResponse.status !== 201) {
    throw new Error(`Failed to create instructor private profile for ${email}: ${privateProfileResponse.status}`);
  }

  const privateProfileData = privateProfileResponse.data;
  if (!privateProfileData || !Array.isArray(privateProfileData) || privateProfileData.length === 0) {
    throw new Error(`Instructor private profile creation returned invalid data for ${email}`);
  }

  const privateProfileId = (privateProfileData[0] as { id: string }).id;
  console.log(`✅ Created instructor private profile ID: ${privateProfileId}`);

  // Step 4: Create user role (enroll instructor in class)
  const userRolePayload = {
    user_id: userId,
    class_id: classId,
    private_profile_id: privateProfileId,
    public_profile_id: publicProfileId,
    role: "instructor"
  };

  const userRoleResponse = makeSupabaseRequest("POST", "user_roles", userRolePayload, config);

  if (userRoleResponse.status !== 201) {
    throw new Error(`Failed to create instructor user role for ${email}: ${userRoleResponse.status}`);
  }

  console.log(`✅ Enrolled instructor ${email} in class`);

  // Step 5: Generate magic link for the instructor
  const magicLinkData = generateMagicLink(email, config);

  return {
    id: `instructor-${testRunPrefix}`,
    profile_id: privateProfileId,
    email,
    user_id: userId,
    public_profile_id: publicProfileId,
    private_profile_id: privateProfileId,
    magic_link: magicLinkData
  };
}

/**
 * Setup function - creates test data
 */
export function setup(): TestData {
  console.log("🚀 Starting DB TPS HTTP test setup...");

  // Get configuration from environment
  const config = getSupabaseConfig();
  const testRunPrefix = generateTestRunPrefix("db-tps");

  console.log(`📊 Test run prefix: ${testRunPrefix}`);

  // Create test class
  const classData = createTestClass(testRunPrefix, config);

  // Create instructor
  const instructor = createTestInstructor(classData.id, testRunPrefix, config);

  // Create three students
  console.log("👥 Creating 3 students...");
  const students: StudentData[] = [];
  for (let i = 1; i <= 3; i++) {
    const student = createTestStudent(i, classData.id, testRunPrefix, "setup", config);
    students.push(student);
  }

  const testData: TestData = {
    config,
    classData,
    instructor,
    students,
    testRunPrefix
  };

  console.log("✅ Setup completed successfully!");
  console.log(`📚 Class: ${classData.name} (ID: ${classData.id})`);
  console.log(`👩‍🏫 Instructor: ${instructor.email}`);
  console.log(`   Magic Link Token: ${instructor.magic_link.hashed_token}`);
  students.forEach((student, index) => {
    console.log(`👤 Student ${index + 1}: ${student.email}`);
    console.log(`   Magic Link Token: ${student.magic_link.hashed_token}`);
  });

  return testData;
}

/**
 * Main test function - minimal test that just validates setup worked
 */
export default function(data: TestData) {
  console.log("🧪 Running minimal validation test...");

  // Verify class exists
  const classCheck = makeSupabaseRequest("GET", `classes?id=eq.${data.classData.id}`, null, data.config);
  check(classCheck, {
    "class exists": (r) => r.status === 200 && Array.isArray(r.data) && r.data.length === 1
  });

  // Verify instructor enrollment
  const instructorCheck = makeSupabaseRequest(
    "GET", 
    `user_roles?class_id=eq.${data.classData.id}&role=eq.instructor`,
    null,
    data.config
  );
  check(instructorCheck, {
    "instructor enrolled": (r) => r.status === 200 && Array.isArray(r.data) && r.data.length === 1
  });

  // Verify student enrollments (should be 3 students)
  const studentCheck = makeSupabaseRequest(
    "GET",
    `user_roles?class_id=eq.${data.classData.id}&role=eq.student`,
    null,
    data.config
  );
  check(studentCheck, {
    "3 students enrolled": (r) => r.status === 200 && Array.isArray(r.data) && r.data.length === 3
  });

  // Verify magic links were generated
  check(data.instructor.magic_link, {
    "instructor magic link generated": (ml) => ml && ml.hashed_token && ml.verification_type
  });

  data.students.forEach((student, index) => {
    check(student.magic_link, {
      [`student ${index + 1} magic link generated`]: (ml) => ml && ml.hashed_token && ml.verification_type
    });
  });

  // Test: Exchange magic links for JWTs and make authenticated requests
  console.log("🔐 Testing JWT exchange for instructor...");
  const instructorAuth = exchangeMagicLinkForAccessToken(data.instructor.magic_link.hashed_token, data.config);
  const instructorHeaders = createUserAuthHeaders(instructorAuth.access_token, data.config.anonKey);
  
  // Make a test request as the instructor
  const instructorProfileCheck = makeSupabaseRequest(
    "GET",
    `profiles?id=eq.${data.instructor.private_profile_id}`,
    null,
    data.config,
    instructorHeaders
  );
  
  check(instructorProfileCheck, {
    "instructor can access own profile with JWT": (r) => r.status === 200 && Array.isArray(r.data) && r.data.length === 1
  });

  console.log("🔐 Testing JWT exchange for student 1...");
  const firstStudent = data.students[0];
  const studentAuth = exchangeMagicLinkForAccessToken(firstStudent.magic_link.hashed_token, data.config);
  const studentHeaders = createUserAuthHeaders(studentAuth.access_token, data.config.anonKey);
  
  // Make a test request as the student
  const studentProfileCheck = makeSupabaseRequest(
    "GET",
    `profiles?id=eq.${firstStudent.private_profile_id}`,
    null,
    data.config,
    studentHeaders
  );
  
  check(studentProfileCheck, {
    "student can access own profile with JWT": (r) => r.status === 200 && Array.isArray(r.data) && r.data.length === 1
  });

  // Test: Query all profiles as each user to see RLS policies in action
  console.log("🔍 Testing profile visibility with RLS policies...");
  
  console.log("👩‍🏫 Querying all profiles as instructor...");
  const instructorAllProfiles = makeSupabaseRequest(
    "GET",
    `profiles`,
    null,
    data.config,
    instructorHeaders
  );
  
  console.log(`   Instructor sees ${Array.isArray(instructorAllProfiles.data) ? instructorAllProfiles.data.length : 0} profiles`);
  if (Array.isArray(instructorAllProfiles.data)) {
    instructorAllProfiles.data.forEach((profile: any, index: number) => {
      console.log(`   Profile ${index + 1}: ${profile.name} (ID: ${profile.id}, Private: ${profile.is_private_profile})`);
    });
  }
  
  check(instructorAllProfiles, {
    "instructor can query profiles": (r) => r.status === 200 && Array.isArray(r.data)
  });

  console.log("👤 Querying all profiles as student...");
  const studentAllProfiles = makeSupabaseRequest(
    "GET",
    `profiles`,
    null,
    data.config,
    studentHeaders
  );
  
  console.log(`   Student sees ${Array.isArray(studentAllProfiles.data) ? studentAllProfiles.data.length : 0} profiles`);
  if (Array.isArray(studentAllProfiles.data)) {
    studentAllProfiles.data.forEach((profile: any, index: number) => {
      console.log(`   Profile ${index + 1}: ${profile.name} (ID: ${profile.id}, Private: ${profile.is_private_profile})`);
    });
  }
  
  check(studentAllProfiles, {
    "student can query profiles": (r) => r.status === 200 && Array.isArray(r.data)
  });

  // Compare what each user can see
  const instructorProfileCount = Array.isArray(instructorAllProfiles.data) ? instructorAllProfiles.data.length : 0;
  const studentProfileCount = Array.isArray(studentAllProfiles.data) ? studentAllProfiles.data.length : 0;
  
  console.log(`📊 Profile visibility comparison:`);
  console.log(`   Instructor can see: ${instructorProfileCount} profiles`);
  console.log(`   Student can see: ${studentProfileCount} profiles`);
  
  if (instructorProfileCount !== studentProfileCount) {
    console.log(`✅ RLS policies working: Different users see different profile counts`);
  } else {
    console.log(`⚠️  Both users see the same number of profiles - check RLS policies`);
  }

  // Test: Query user_roles as each user to see enrollment/role visibility
  console.log("");
  console.log("🔍 Testing user_roles visibility (more sensitive data)...");
  
  console.log("👩‍🏫 Querying all user_roles as instructor...");
  const instructorUserRoles = makeSupabaseRequest(
    "GET",
    `user_roles`,
    null,
    data.config,
    instructorHeaders
  );
  
  console.log(`   Instructor sees ${Array.isArray(instructorUserRoles.data) ? instructorUserRoles.data.length : 0} user_roles entries`);
  if (Array.isArray(instructorUserRoles.data)) {
    instructorUserRoles.data.forEach((role: any, index: number) => {
      console.log(`   Role ${index + 1}: Class ${role.class_id}, Role: ${role.role}, User: ${role.user_id?.substring(0, 8)}...`);
    });
  }
  
  check(instructorUserRoles, {
    "instructor can query user_roles": (r) => r.status === 200 && Array.isArray(r.data)
  });

  console.log("👤 Querying all user_roles as student...");
  const studentUserRoles = makeSupabaseRequest(
    "GET",
    `user_roles`,
    null,
    data.config,
    studentHeaders
  );
  
  console.log(`   Student sees ${Array.isArray(studentUserRoles.data) ? studentUserRoles.data.length : 0} user_roles entries`);
  if (Array.isArray(studentUserRoles.data)) {
    studentUserRoles.data.forEach((role: any, index: number) => {
      console.log(`   Role ${index + 1}: Class ${role.class_id}, Role: ${role.role}, User: ${role.user_id?.substring(0, 8)}...`);
    });
  }
  
  check(studentUserRoles, {
    "student can query user_roles": (r) => r.status === 200 && Array.isArray(r.data)
  });

  // Compare user_roles visibility
  const instructorRoleCount = Array.isArray(instructorUserRoles.data) ? instructorUserRoles.data.length : 0;
  const studentRoleCount = Array.isArray(studentUserRoles.data) ? studentUserRoles.data.length : 0;
  
  console.log(`📊 User roles visibility comparison:`);
  console.log(`   Instructor can see: ${instructorRoleCount} user_roles entries`);
  console.log(`   Student can see: ${studentRoleCount} user_roles entries`);
  
  if (instructorRoleCount !== studentRoleCount) {
    console.log(`✅ RLS policies working: Different users see different user_roles counts`);
  } else {
    console.log(`⚠️  Both users see the same number of user_roles - check RLS policies`);
  }

  // Expected: instructor should see all 4 enrollments (1 instructor + 3 students)
  // Expected: student should see only their own enrollment or maybe all in their class
  console.log("");
  console.log("💡 Expected behavior:");
  console.log("   - Instructor should see all 4 enrollments in this class");
  console.log("   - Student should see limited enrollments (depends on RLS policy)");

  console.log("✅ Validation completed!");
}

/**
 * Teardown function - logs cleanup information
 */
export function teardown(data: TestData) {
  logCleanupInfo(data.classData.id, "DB TPS HTTP");
  console.log(`🎯 Test data created with prefix: ${data.testRunPrefix}`);
  console.log("📋 Magic Link Tokens for Authentication:");
  console.log(`   Instructor Token: ${data.instructor.magic_link.hashed_token}`);
  data.students.forEach((student, index) => {
    console.log(`   Student ${index + 1} Token: ${student.magic_link.hashed_token}`);
  });
  console.log("");
  console.log("🔧 To use these in performance tests:");
  console.log("1. Call exchangeMagicLinkForAccessToken(token, config) to get JWT");
  console.log("2. Use createUserAuthHeaders(jwt, anonKey) for authenticated requests");
  console.log("3. Pass user headers to makeSupabaseRequest() for user-scoped API calls");
  console.log("");
  console.log("Example:");
  console.log("  const auth = exchangeMagicLinkForAccessToken(students[0].magic_link.hashed_token, config);");
  console.log("  const headers = createUserAuthHeaders(auth.access_token, config.anonKey);");
  console.log("  const response = makeSupabaseRequest('GET', 'user_roles?class_id=eq.123', null, config, headers);");
  console.log("");
  console.log("💡 Note: Using anonKey (not serviceRoleKey) to respect RLS policies");
  console.log("");
  console.log("💡 You can now customize this setup for your specific testing needs");
}
