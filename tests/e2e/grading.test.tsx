import { test, expect, type Page } from "@playwright/test";

test.describe('An end-to-end grading workflow self-review to grading', () => {
  test.describe.configure({ mode: 'serial' })
  test('Students can submit self-review early', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('textbox', { name: 'Sign in email' }).click();
    await page.getByRole('textbox', { name: 'Sign in email' }).fill('student@pawtograder.net');
    await page.getByRole('textbox', { name: 'Sign in email' }).press('Tab');
    await page.getByRole('textbox', { name: 'Sign in password' }).fill('student');
    await page.getByRole('textbox', { name: 'Sign in password' }).press('Enter');
    await page.getByRole('button', { name: 'Sign in with email' }).click();
    await page.getByRole('link', { name: 'Demo Assignment' }).click();
    await page.getByRole('button', { name: 'Finalize Submission Early' }).click();
    await page.getByRole('button', { name: 'Confirm action' }).click();
    await page.getByRole('button', { name: 'Complete Self Review' }).click();
    await page.getByText('public int doMath(int a, int').click({
      button: 'right'
    });
    await page.getByRole('option', { name: 'Leave a comment' }).click();
    await page.getByRole('textbox', { name: 'Add a comment about this line' }).click();
    await page.getByRole('textbox', { name: 'Add a comment about this line' }).fill('here is a comment');
    await page.getByRole('button', { name: 'Add Comment' }).click();
    await page.getByText('Annotate line 15 with a check:').waitFor({ state: 'hidden' });

    await page.getByText('5 System.out.println("Hello,').click({
      button: 'right'
    });
    await page.getByRole('option', { name: 'Self Review Check 1 (+5)' }).click();
    await page.getByRole('textbox', { name: 'Optionally add a comment, or' }).fill('comment');
    await page.getByRole('button', { name: 'Add Check' }).click();
    await page.getByText('Annotate line 5 with a check:').waitFor({ state: 'hidden' });

    await page.getByLabel('Self Review Check 2 (+5)').click()

    await page.getByRole('textbox', { name: 'Optional: comment on check Self Review Check 2' }).click();
    await page.getByRole('textbox', { name: 'Optional: comment on check Self Review Check 2' }).fill('Hi');
    await page.getByRole('button', { name: 'Add Check' }).click();
    await page.getByRole('button', { name: 'Complete Review' }).click();
    await page.getByRole('button', { name: 'Mark as Complete' }).click();
  });

  test('Instructors can view the student\'s self-review and create their own grading review', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('textbox', { name: 'Sign in email' }).click();
    await page.getByRole('textbox', { name: 'Sign in email' }).fill('instructor@pawtograder.net');
    await page.getByRole('textbox', { name: 'Sign in password' }).click();
    await page.getByRole('textbox', { name: 'Sign in password' }).fill('instructor');
    await page.getByRole('button', { name: 'Sign in with email' }).click();
    await page.getByRole('link', { name: 'Demo Assignment' }).click();
    const page1Promise = page.waitForEvent('popup');
    await page.getByRole('cell', { name: 'Alyssa P Hacker' }).getByRole('button').click();
    const page1 = await page1Promise;
    await page1.getByRole('button', { name: 'Files' }).click();

    await expect(page1.getByLabel('Rubric: Self-Review Rubric')).toContainText('Alyssa P Hacker applied today at');
   
    await page1.getByText('public static void main(').click({
      button: 'right'
    });
    await page1.getByRole('option', { name: 'Grading Review Check 1 (+10)' }).click();
    await page1.getByRole('textbox', { name: 'Optionally add a comment, or' }).fill('grading comment again');
    await page1.getByRole('button', { name: 'Add Check' }).click();
    await page1.getByText('Annotate line 4 with a check:').waitFor({ state: 'hidden' });

    await page1.getByLabel('Grading Review Check 2 (+10)').click();
    await page1.getByRole('textbox', { name: 'Optional: comment on check Grading Review Check 2' }).click();
    await page1.getByRole('textbox', { name: 'Optional: comment on check Grading Review Check 2' }).fill('grading comment');
    await page1.getByRole('button', { name: 'Add Check' }).click();


    await page1.getByRole('button', { name: 'Complete Review' }).click();
    await page1.getByRole('button', { name: 'Mark as Complete' }).click();
    await page1.getByRole('button', { name: 'Release To Student' }).click();
  });
  test('Students can view their grading results', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('textbox', { name: 'Sign in email' }).click();
    await page.getByRole('textbox', { name: 'Sign in email' }).fill('student@pawtograder.net');
    await page.getByRole('textbox', { name: 'Sign in email' }).press('Tab');
    await page.getByRole('textbox', { name: 'Sign in password' }).fill('student');
    await page.getByRole('button', { name: 'Sign in with email' }).click();
    await page.getByRole('link', { name: 'Demo Assignment' }).click();
    await page.getByRole('link', { name: '1', exact: true }).click();

    await page.getByRole('button', { name: 'Files' }).click();
    await page.getByText('public int doMath(int a, int').click();

    await expect(page.locator('#rubric-1')).toContainText('Grading Review Criteria 20/20');

    await expect(page.getByLabel('Rubric: Grading Rubric')).toContainText('Eva Lu Ator applied today');
    await expect(page.locator('body')).toContainText('grading comment again');
  });

});