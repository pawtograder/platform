# Pawtograder Course Operations Platform

[![Covered by Argos Visual Testing](https://argos-ci.com/badge.svg)](https://app.argos-ci.com/pawtograder/platform/reference?utm_source=pawtograder&utm_campaign=oss)

Pawtograder is a course operations platform for instructors and students. It provides "autograder" functionality (automated grading of programming assignments, combining instructor support and handgrading inspired by Autolab and Autograder.io with GitHub integration inspired by GitHub Classroom) and other interactive features like Q&A, office hours queue, and more.

It is under active development.

## Documentation

Documentation is also a work in progress, and is maintained in the [pawtograder/docs](https://github.com/pawtograder/docs) repository. Documentation is available at [https://docs.pawtograder.com/](https://docs.pawtograder.com/), with documentation organized for:

- [Developers](https://docs.pawtograder.com/developers/intro/)
- [Course Staff](https://docs.pawtograder.com/staff/intro/)
- [Students](https://docs.pawtograder.com/students/intro/)

See also: [pawtograder/assignment-action](https://github.com/pawtograder/assignment-action), the GitHub Action that grades student assignments in CI and also runs regression testing for grader development.

## Quick start for local development

The quickest way to get started with development is to use our staging environment as a backend and run the frontend locally. For features requiring database schema changes or to run end-to-end tests, see [Setting up Supabase locally](#setting-up-supabase-locally) below.

1. Ensure that you have a recent version of Node.js installed (v22 is a good choice). If you need to install NodeJS, we suggest using [nvm](https://github.com/nvm-sh/nvm) to install it, which will also make your life much easier when you need to switch between different versions of NodeJS.
2. Clone this repository.
3. Run `npm install` to install the dependencies. You can ignore the warnings from `amazon-chime-sdk-component-library-react` complaining about Node versions, along with the wall of "deprecated" warnings.
4. Copy the `.env.local.staging` file to `.env.local` and fill in your own values.
5. Run `npm run dev` to start the development server. Follow the instructions in the terminal to view the application. The application will automatically reload if you make changes to the code. The frontend will be available at `https://localhost:3000`. It will set up a self-signed certificate to host the page (HTTPS is required to access camera/microphone for the help queue), so you'll need to click through a browser warning.

In a clean development environment, it is possible to register an account with any email address without confirmation. To get started, simply create a new account. By default, it will be added to the "demo class" as a student. To create a new account in the demo class as an instructor, include the word "instructor" in your email address.

## Setting up Supabase locally

For development work that requires changes to the database schema or backend functionality, you'll need to set up a local Supabase instance. This setup is also required for running Playwright end-to-end tests and requires Docker.

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed and running
- Node.js (v22 recommended)

### Setup steps

1. Install dependencies: `npm install`
2. Start Supabase locally: `npx supabase start` - This will start all Supabase services in Docker containers.
3. Reset the database: `npx supabase db reset` - This applies all database migrations and seeds the database with initial data.
4. Update your `.env.local` file: After running `npx supabase start`, you'll see output with local service URLs and keys. Update your `.env.local` file with these values:
   - `SUPABASE_URL` - Local API URL (typically `http://127.0.0.1:54321`)
   - `NEXT_PUBLIC_SUPABASE_URL` - Same as `SUPABASE_URL` for client-side SDKs
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` - The "anon key" from the output
   - `SUPABASE_SERVICE_ROLE_KEY` - The "service_role key" (server-side only; used by admin scripts/e2e)
   - (Optional) `ENABLE_SIGNUPS=true` - If you want to easily create new users using the UI for local dev

   > Security: Never expose `SUPABASE_SERVICE_ROLE_KEY` to the browser or commit it. Keep it in server-only code and CI secrets.

5. Build the application: `npm run build`
6. Start Supabase Edge Functions: `npx supabase functions serve`
7. Start the development server: `npm start`
8. Run end-to-end tests (optional): `npx playwright test --ui`

### Local development workflow

Once the local Supabase setup is complete, you can develop with the full local stack. The Supabase dashboard will be available at `http://localhost:54323` where you can view and manage your local database, auth users, storage, and more. You can also access the local email interface at `http://localhost:54324` to view captured emails from development (useful for testing authentication flows).

Note that additional configuration may be needed for features like GitHub integration depending on your development needs.

## Linting

- Run `npm run lint` to run eslint and prettier.

- Run `npm run format` to format with prettier.

## License

This project is licensed under the GPLv3 license. See the [LICENSE](LICENSE) file for details.

## Acknowledgements

This project was made possible thanks to the support of [Khoury College of Computer Sciences](https://www.khoury.northeastern.edu/), and benefits tremendously from the input of many students, instructors, and staff.
