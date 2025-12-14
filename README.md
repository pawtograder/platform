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
9. Create a small testing class with a few students and assignments for interactive testing: `npm run seed`. It will print out a LOT of output. Scroll up or search for "Login Credentials" to find the email addresses and passwords that you can use to log in to the test class.

### Local development workflow

Once the local Supabase setup is complete, you can develop with the full local stack. The Supabase dashboard will be available at `http://localhost:54323` where you can view and manage your local database, auth users, storage, and more. You can also access the local email interface at `http://localhost:54324` to view captured emails from development (useful for testing authentication flows).

Note that additional configuration may be needed for features like GitHub integration depending on your development needs.

## Discord Bot Setup

The Discord bot integration allows staff members to receive real-time notifications about help requests and regrade requests in Discord channels. The bot automatically creates channels for assignments, labs, and office hours queues, and posts notifications when requests are created or updated.

### Prerequisites

1. **Discord Application**: Create a Discord application at [Discord Developer Portal](https://discord.com/developers/applications)
2. **Discord Bot**: Create a bot user for your application and note the bot token
3. **OAuth2 Setup**: Configure OAuth2 redirect URI in your Discord application settings

### Environment Variables

Add the following environment variables to your `.env.local` file:

#### Required Variables

- `DISCORD_BOT_TOKEN` - Your Discord bot token (found in Bot section of Discord Developer Portal)
- `DISCORD_CLIENT_ID` - Your Discord application client ID (found in OAuth2 section)
- `DISCORD_CLIENT_SECRET` - Your Discord application client secret (found in OAuth2 section)
- `NEXT_PUBLIC_DISCORD_CLIENT_ID` - Same as `DISCORD_CLIENT_ID` (required for frontend OAuth flow)
- `DISCORD_WEBHOOK_PUBLIC_KEY` - Your Discord webhook's public key for signature verification (found in Webhooks section → Your Webhook → "Signing Secret" or "Public Key"). This is hex-encoded and can include or omit the `0x` prefix. Required for webhook security.

#### Optional Variables (for Rate Limiting)

- `UPSTASH_REDIS_REST_URL` - Upstash Redis REST URL for distributed rate limiting (optional, falls back to local limiter)
- `UPSTASH_REDIS_REST_TOKEN` - Upstash Redis REST token (optional, falls back to local limiter)

### Discord Application Configuration

1. **Create Discord Application**:

   - Go to [Discord Developer Portal](https://discord.com/developers/applications)
   - Click "New Application" and give it a name
   - Note your Application ID (this is your `DISCORD_CLIENT_ID`)

2. **Create Bot User**:

   - Navigate to the "Bot" section in your application
   - Click "Add Bot" and confirm
   - Under "Token", click "Reset Token" or "Copy" to get your bot token (this is your `DISCORD_BOT_TOKEN`)
   - Enable the following Privileged Gateway Intents (if needed):
     - Server Members Intent (for user mentions)

3. **Configure OAuth2**:

   - Navigate to the "OAuth2" section
   - Under "Redirects", add your callback URL:
     - For local development: `http://localhost:3000/api/discord/oauth/callback`
     - For production: `https://app.pawtograder.com/api/discord/oauth/callback`
   - Note your Client Secret (this is your `DISCORD_CLIENT_SECRET`)

4. **Bot Permissions**:
   When inviting the bot to your Discord server, ensure it has the following permissions:

   - Manage Channels (to create channels)
   - Send Messages (to post notifications)
   - Read Message History (to read channel context)
   - Mention Everyone (to @ mention users)
   - Use External Emojis (optional, for better message formatting)
   - Add Reactions (optional, for feedback on help requests)
   - Manage Roles (to assign roles to users)

   You can generate an invite URL with these permissions using the OAuth2 URL Generator in the Discord Developer Portal, or manually construct:

   ```text
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=268896336&scope=bot
   ```

5. **Configure Webhook** (for automatic role assignment):
   - Navigate to the "Webhooks" section in your Discord application
   - Click "New Webhook"
   - Set the webhook URL to:
     - For local development: `http://localhost:3000/api/discord/webhook` (use ngrok or similar for testing)
     - For production: `https://app.pawtograder.com/api/discord/webhook` (or your domain)
   - Copy the webhook's **public key** (found in the webhook settings, labeled "Signing Secret" or "Public Key")
   - Add it to your environment variables as `DISCORD_WEBHOOK_PUBLIC_KEY`:

### Setting Up Discord Integration for a Class

1. **Link Discord Account** (for staff):

   - Navigate to the course page
   - Click "Connect Discord" to link your Discord account via OAuth
   - This allows the system to identify you for @ mentions

2. **Configure Discord Server** (for instructors):

   - Navigate to `/course/[course_id]/manage/discord`
   - Enter your Discord Server ID (right-click server → Copy Server ID, requires Developer Mode)
   - Optionally enter a Channel Group ID (right-click a category → Copy ID) to organize channels
   - Click "Save Configuration"

3. **Enable Developer Mode in Discord**:
   - Open Discord Settings → Advanced
   - Enable "Developer Mode"
   - Now you can right-click servers, channels, and categories to copy their IDs

### How It Works

Once configured, the Discord bot will:

- **Auto-create channels** when assignments, labs, or office hours queues are created
- **Post help requests** to the appropriate office hours channel with status updates
- **Post regrade requests** to the `#regrades` channel, @ mentioning the grader
- **Update messages** when request status changes (open → in_progress → resolved)
- **Show feedback** (thumbs up/down) when help requests are resolved with student feedback
- **Escalate notifications** by @ mentioning instructors when regrade requests are appealed

Staff members can click the Discord icon on help requests and regrade requests in the Pawtograder UI to open the Discord message in a new tab for side-chat.

### Edge Function Configuration

For the Discord async worker to function, ensure your Supabase Edge Functions have the Discord environment variables set:

```bash
# In your Supabase project settings or local .env file
DISCORD_BOT_TOKEN=your_bot_token_here
UPSTASH_REDIS_REST_URL=your_upstash_url  # Optional
UPSTASH_REDIS_REST_TOKEN=your_upstash_token  # Optional
```

### Next.js API Route Configuration

For the Discord webhook endpoint to function, ensure your Next.js application has the webhook public key set:

```bash
# In your .env.local file or production environment
DISCORD_WEBHOOK_PUBLIC_KEY=your_webhook_public_key_here  # Hex-encoded, 64 characters
```

The Discord async worker (`discord-async-worker`) processes Discord API calls asynchronously with rate limiting and retry logic, similar to the GitHub async worker pattern.

The Discord webhook endpoint (`/api/discord/webhook`) receives events from Discord when users join servers, verifies signatures using ed25519 cryptography, and automatically triggers role assignment.

## Linting

- Run `npm run lint` to run eslint and prettier.

- Run `npm run format` to format with prettier.

## License

This project is licensed under the GPLv3 license. See the [LICENSE](LICENSE) file for details.

## Acknowledgements

This project was made possible thanks to the support of [Khoury College of Computer Sciences](https://www.khoury.northeastern.edu/), and benefits tremendously from the input of many students, instructors, and staff.
