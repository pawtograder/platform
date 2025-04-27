# Pawtograder Course Operations Platform
 
 Pawtograder is a course operations platform for instructors and students. It provides "autograder" functionality (automated grading of programming assignments, combining instructor support and handgrading inspired by Autolab and Autograder.io with GitHub integration inspired by GitHub Classroom) and other interactive features like Q&A, office hours queue, and more.
 
 It is under active development.

 ## Documentation
Documentation is also a work in progress, and is maintained in the [pawtograder/docs](https://github.com/pawtograder/docs) repository. Documentation is available at [https://docs.pawtograder.com/](https://docs.pawtograder.com/), with documentation organized for:
- [Developers](https://docs.pawtograder.com/developers/intro/)
- [Course Staff](https://docs.pawtograder.com/staff/intro/)
- [Students](https://docs.pawtograder.com/students/intro/)

See also: [pawtograder/assignment-action](https://github.com/pawtograder/assignment-action), the GitHub Action that grades student assignments in CI and also runs regression testing for grader development.

 ## Quick start for local development

The quickest way to get started with development is to use our staging environment as a backend, and run the frontend locally.
In order to develop new features that require changing the data model, you will instead need to [set up a local supabase dev instance](https://supabase.com/docs/guides/local-development/cli/getting-started), which requires installing Docker.

 1. Ensure that you have a recent version of Node.js installed (v22 is a good choice). If you need to install NodeJS, we suggest using [nvm](https://github.com/nvm-sh/nvm) to install it, which will also make your life much easier when you need to switch between different versions of NodeJS.
 2. Clone this repository.
 3. Run `npm install` to install the dependencies. You can ignore the warnings from `amazon-chime-sdk-component-library-react` complaining about Node versions, along with the wall of "deprecated" warnings.
 4. Copy the `.env.local.staging` file to `.env.local` and fill in your own values.
 5. Run `npm run dev` to start the development server. Follow the instructions in the terminal to view the application. The application will automatically reload if you make changes to the code. The frontend will be available at `https://localhost:3000`. It will set up a self-signed certificate to host the page (HTTPS is required to access camera/microphone for the help queue), so you'll need to click through a browser warning.

In a clean development environment, it is possible to register an account with any email address without confirmation. To get started, simply create a new account. By default, it will be added to the "demo class" as a student. To create a new account in the demo class as an instructor, include the word "instructor" in your email address.

# License
This project is licensed under the GPLv3 license. See the [LICENSE](LICENSE) file for details.

# Acknowledgements
This project was made possible thanks to the support of [Khoury College of Computer Sciences](https://www.khoury.northeastern.edu/), and benefits tremendously from the input of many students, instructors, and staff.

This project is NOT tested with BrowserStack, perhaps one day their open-source program will cover us.