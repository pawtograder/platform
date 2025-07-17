import { test, expect, type Page } from "@playwright/test";
import {
  createClass,
  createClassSection,
  createLabSectionWithStudents,
  createUserInClass,
  createUserInDemoClass,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";
import { ClassSection, Course, LabSection } from "@/utils/supabase/DatabaseTypes";
import { EmailNotification } from "@/components/ui/notifications/notification-teaser";

let course: Course;
let section1: ClassSection;
let section2: ClassSection;
let section1Students: TestingUser[];
let section2Students: TestingUser[];

let lab1: LabSection;
let lab2: LabSection;
let lab1Leader: TestingUser;
let lab2Leader: TestingUser;
let lab1Students: TestingUser[];
let lab2Students: TestingUser[];
let instructor: TestingUser;
async function createSectionWithStudents(numStudents: number) {
  const section = await createClassSection({ class_id: course.id });
  const students = [];
  for (let i = 0; i < numStudents; i++) {
    const student = await createUserInClass({ role: "student", class_id: course.id, section_id: section.id });
    students.push(student);
  }
  return { section, students };
}

async function createLabWithStudents(numStudents: number, labLeader: TestingUser) {
  const students = [];
  const lab = await createLabSectionWithStudents({
    class_id: course.id,
    lab_leader: labLeader,
    day_of_week: "monday",
    students: [],
    start_time: "10:00",
    end_time: "11:00"
  });
  for (let i = 0; i < numStudents; i++) {
    const student = await createUserInClass({ role: "student", class_id: course.id, lab_section_id: lab.id });
    students.push(student);
  }
  return { lab, students };
}
test.beforeAll(async () => {
  //Create a new class for this test
  const course_res = await createClass();
  course = course_res;
  instructor = await createUserInClass({ role: "instructor", class_id: course.id });
  lab1Leader = await createUserInClass({ role: "grader", class_id: course.id });
  lab2Leader = await createUserInClass({ role: "grader", class_id: course.id });

  //Create a section with 5 students
  const { section: _section1, students: _section1Students } = await createSectionWithStudents(5);
  section1 = _section1;
  section1Students = _section1Students;
  //Create a section with 5 students
  const { section: _section2, students: _section2Students } = await createSectionWithStudents(5);
  section2 = _section2;
  section2Students = _section2Students;

  //Create a lab with 5 students
  const { lab: _lab1, students: _lab1Students } = await createLabWithStudents(5, lab1Leader);
  lab1 = _lab1;
  lab1Students = _lab1Students;
  //Create a lab with 5 students
  const { lab: _lab2, students: _lab2Students } = await createLabWithStudents(5, lab2Leader);
  lab2 = _lab2;
  lab2Students = _lab2Students;
});

async function sendBatchEmails({
  page,
  target_text,
  class_section_text,
  lab_section_text
}: {
  page: Page;
  target_text: string;
  class_section_text?: string;
  lab_section_text?: string;
}) {
  const randomString1 = Math.random().toString(36).substring(2, 15);
  const randomString2 = Math.random().toString(36).substring(2, 15);
  const message_subject = `E2E Test Email ${target_text} ${class_section_text ? `in ${class_section_text}` : ""} ${lab_section_text ? `in ${lab_section_text}` : ""}. ${randomString1}`;
  const message_body = `This is a test email to ${target_text} ${class_section_text ? `in ${class_section_text}` : ""} ${lab_section_text ? `in ${lab_section_text}` : ""} ${randomString2}`;
  await page.getByRole("combobox", { name: "Email To" }).click();
  await page.getByRole("option", { name: "Students", exact: true }).click();
  if (class_section_text) {
    await page.getByRole("combobox", { name: "Select class section(s)" }).click();
    await page.getByRole("option", { name: class_section_text }).click();
  }
  if (lab_section_text) {
    await page.getByRole("combobox", { name: "Select lab section(s)" }).click();
    await page.getByRole("option", { name: lab_section_text }).click();
  }
  await page.getByRole("textbox", { name: "Subject" }).click();
  await page.getByRole("textbox", { name: "Subject" }).fill(message_subject);
  await page.getByRole("textbox", { name: "Email body" }).click();
  await page.getByRole("textbox", { name: "Email body" }).fill(message_body);
  await page.getByRole("button", { name: "Add to Preview" }).click();
  await page.getByRole("button", { name: "Send emails" }).click();
  return {
    subject: message_subject,
    body: message_body
  };
}
async function expectStudentsReceivedExactlyTheseEmails({
  students,
  expected_emails
}: {
  students: TestingUser[];
  expected_emails: {
    subject: string;
    body: string;
  }[];
}) {
  const { data: allEmailsSent, error: emailError } = await supabase
    .from("emails")
    .select("*")
    .eq("class_id", course.id)
    .limit(1000);
  if (emailError) {
    throw new Error(`Error getting emails: ${emailError.message}`);
  }
  const { data: allNotifications, error: notificationError } = await supabase
    .from("notifications")
    .select("*")
    .eq("class_id", course.id)
    .limit(1000);
  if (notificationError) {
    throw new Error(`Error getting notifications: ${notificationError.message}`);
  }
  async function expectStudentReceivedEmail({
    student,
    expected_email
  }: {
    student: TestingUser;
    expected_email: {
      subject: string;
      body: string;
    };
  }) {
    const thisEmail = allEmailsSent?.find(
      (email) => email.subject === expected_email.subject && email.body === expected_email.body
    );
    expect(
      thisEmail,
      `Expected email ${expected_email.subject} for student ${student.email}, but got ${thisEmail}`
    ).toBeDefined();
    const thisNotification = allNotifications?.find(
      (notification) => notification.user_id === student.user_id && notification.subject === expected_email.subject
    );
    expect(
      thisNotification,
      `Expected notification ${expected_email.subject} for student ${student.email}, but got ${thisNotification}`
    ).toBeDefined();
    if (thisNotification) {
      const notificationBody = thisNotification.body as EmailNotification;
      expect(notificationBody.body).toEqual(expected_email.body);
      expect(notificationBody.type).toEqual("email");
      expect(notificationBody.action).toEqual("create");
      expect(notificationBody.subject).toEqual(expected_email.subject);
      expect(notificationBody.reply_to).toEqual(instructor.email);
    }
  }
  for (const student of students) {
    const totalNotifications = allNotifications?.filter(
      (notification) => notification.user_id === student.user_id && notification.style === "email"
    ).length;
    expect(
      totalNotifications,
      `Expected ${expected_emails.length} emails for student ${student.email}, but got ${totalNotifications}`
    ).toEqual(expected_emails.length);
    const totalEmails = allEmailsSent?.filter((email) => email.user_id === student.user_id).length;
    expect(
      totalEmails,
      `Expected ${expected_emails.length} emails for student ${student.email}, but got ${totalEmails}`
    ).toEqual(expected_emails.length);
    for (const expected_email of expected_emails) {
      await expectStudentReceivedEmail({ student, expected_email });
    }
  }
}
test.describe("Emailer", () => {
  test("Emailing students in a class section or lab section", async ({ page }) => {
    await loginAsUser(page, instructor);
    await expect(page.getByText(course!.name!)).toBeVisible();
    await page.goto(`/course/${course.id}/manage/course/emails`);
    const section1Message = await sendBatchEmails({ page, target_text: "Students", class_section_text: section1.name });
    const section2Message = await sendBatchEmails({ page, target_text: "Students", class_section_text: section2.name });
    const lab1Message = await sendBatchEmails({ page, target_text: "Students", lab_section_text: lab1.name });
    const lab2Message = await sendBatchEmails({ page, target_text: "Students", lab_section_text: lab2.name });
    //Wait for emails to finish being inserted, TODO: Make this more robust
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await expectStudentsReceivedExactlyTheseEmails({ students: section1Students, expected_emails: [section1Message] });
    await expectStudentsReceivedExactlyTheseEmails({ students: section2Students, expected_emails: [section2Message] });
    await expectStudentsReceivedExactlyTheseEmails({ students: lab1Students, expected_emails: [lab1Message] });
    await expectStudentsReceivedExactlyTheseEmails({ students: lab2Students, expected_emails: [lab2Message] });
  });
});
