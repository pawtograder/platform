# rails runner script: seed a Canvas course with a teacher, students, and a
# published assignment for Pawtograder LTI 1.3 e2e tests.
#
# Idempotent: re-running reuses the course (by course_code) and users (by login
# email). Logins get a known password so Playwright can sign in and launch.
#
# Env (all optional; defaults are deterministic so the e2e harness can hardcode):
#   PG_COURSE_NAME    default "Pawtograder E2E Course"
#   PG_COURSE_CODE    default "PAW-E2E"
#   PG_TEACHER_EMAIL  default "teacher.e2e@example.com"
#   PG_STUDENT_EMAILS default "student1.e2e@example.com,student2.e2e@example.com"
#   PG_USER_PASSWORD  default "pawtograder-e2e"
#   PG_ASSIGNMENT_NAME default "E2E Assignment 1"
#   PG_ASSIGNMENT_POINTS default 100
#
# Prints (KEY=VALUE lines the harness parses):
#   COURSE_ID, COURSE_LTI_CONTEXT_ID, COURSE_CODE
#   TEACHER_EMAIL, TEACHER_PASSWORD, TEACHER_USER_ID
#   STUDENT_EMAIL=<email> (one per student), STUDENT_USER_ID=<id>
#   ASSIGNMENT_ID, ASSIGNMENT_POINTS

account = Account.default

course_name   = ENV.fetch("PG_COURSE_NAME", "Pawtograder E2E Course")
course_code   = ENV.fetch("PG_COURSE_CODE", "PAW-E2E")
teacher_email = ENV.fetch("PG_TEACHER_EMAIL", "teacher.e2e@example.com")
student_emails = ENV.fetch("PG_STUDENT_EMAILS", "student1.e2e@example.com,student2.e2e@example.com")
                   .split(",").map(&:strip).reject(&:empty?)
password      = ENV.fetch("PG_USER_PASSWORD", "pawtograder-e2e")
assignment_name = ENV.fetch("PG_ASSIGNMENT_NAME", "E2E Assignment 1")
assignment_points = ENV.fetch("PG_ASSIGNMENT_POINTS", "100").to_i

# --- find-or-create a user with a login (pseudonym) + active email channel ----
def upsert_user(account, name, email, password)
  pseudonym = Pseudonym.active.by_unique_id(email).first
  if pseudonym
    user = pseudonym.user
  else
    user = User.create!(name: name)
    user.register! # workflow_state -> registered, so they can log in
    account.pseudonyms.create!(
      user: user,
      unique_id: email,
      password: password,
      password_confirmation: password
    )
  end
  # Ensure the user has the requested name and an ACTIVE email comm channel
  # (NRPS/launch share the email; Pawtograder needs it to bridge the session).
  user.update!(name: name) if user.name != name
  cc = user.communication_channels.email.by_path(email).first
  if cc.nil?
    cc = user.communication_channels.create!(path: email, path_type: "email")
  end
  cc.update!(workflow_state: "active") unless cc.active?
  user
end

# --- course (idempotent by course_code) --------------------------------------
course = account.courses.where(course_code: course_code).first
course ||= account.courses.create!(name: course_name, course_code: course_code)
course.update!(name: course_name) if course.name != course_name
course.offer! unless course.available? # workflow_state -> available

# --- teacher -----------------------------------------------------------------
teacher = upsert_user(account, "E2E Teacher", teacher_email, password)
unless course.enrollments.where(user_id: teacher.id, type: "TeacherEnrollment").active.exists?
  course.enroll_user(teacher, "TeacherEnrollment", enrollment_state: "active")
end

# --- students ----------------------------------------------------------------
students = student_emails.each_with_index.map do |email, i|
  s = upsert_user(account, "E2E Student #{i + 1}", email, password)
  unless course.enrollments.where(user_id: s.id, type: "StudentEnrollment").active.exists?
    course.enroll_user(s, "StudentEnrollment", enrollment_state: "active")
  end
  [email, s]
end

# --- assignment (published, online submission, gradable) ---------------------
assignment = course.assignments.where(title: assignment_name).first
assignment ||= course.assignments.create!(
  title: assignment_name,
  points_possible: assignment_points,
  submission_types: "online_text_entry",
  workflow_state: "published"
)
assignment.update!(workflow_state: "published") unless assignment.published?

# --- LTI context id (what the launch/NRPS will key on) -----------------------
lti_context_id =
  begin
    course.lti_context_id || Lti::Asset.opaque_identifier_for(course)
  rescue StandardError
    course.lti_context_id
  end

puts "COURSE_ID=#{course.id}"
puts "COURSE_CODE=#{course.course_code}"
puts "COURSE_LTI_CONTEXT_ID=#{lti_context_id}"
puts "TEACHER_EMAIL=#{teacher_email}"
puts "TEACHER_PASSWORD=#{password}"
puts "TEACHER_USER_ID=#{teacher.id}"
students.each do |email, s|
  puts "STUDENT_EMAIL=#{email}"
  puts "STUDENT_USER_ID=#{s.id}"
end
puts "ASSIGNMENT_ID=#{assignment.id}"
puts "ASSIGNMENT_POINTS=#{assignment_points}"
