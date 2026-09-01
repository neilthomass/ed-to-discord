# EdToDiscord

**EdToDiscord** is a serverless Cloudflare Worker that checks Ed Discussion every five minutes and sends new public announcements and staff-authored threads to Discord webhooks.

There is no server, Docker container, or always-running process to maintain. A Cloudflare Cron Trigger runs the Worker, and Workers KV stores one SHA-256 last-seen cursor per Ed course.

## What it sends

- Public Ed threads whose type is `announcement`
- Public threads authored by an Ed user with the `staff` or `admin` course role
- One Discord embed per matching thread, in oldest-to-newest order
- Multiple courses, each routed to its own Discord webhook (or several courses routed to the same webhook)

Private threads are never sent. The first poll only records the newest existing thread in each course; it does not flood Discord with historical posts. Delivery is at-least-once: an extremely narrow failure between Discord accepting a message and KV saving its cursor can cause a duplicate on the next run.

## Before you begin

You need:

1. A [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers enabled.
2. [Node.js](https://nodejs.org/) 20 or newer (which includes npm).
3. An Ed account that can view every course you want to monitor.
4. Permission to create a webhook in each destination Discord channel.

## 1. Create the Discord webhook

For each destination channel:

1. Open Discord and choose **Edit Channel → Integrations → Webhooks**.
2. Choose **New Webhook**, give it a name, and select the channel.
3. Choose **Copy Webhook URL** and keep the URL private. Anyone with it can post to that channel.

Discord's [webhook introduction](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks) has screenshots if the menu is unfamiliar.

## 2. Create an Ed API token and find course IDs

1. Sign in to Ed and open [Settings → API Tokens](https://edstem.org/us/settings/api-tokens).
2. Create and copy a token. Treat it like a password.
3. Open each course in Ed. Its numeric course ID is in the address, for example `12345` in:

   ```text
   https://edstem.org/us/courses/12345/discussion
   ```

For manual deployment, the course-to-webhook setting is a single-line JSON object:

```json
{"12345":"https://discord.com/api/webhooks/AAA/BBB","67890":"https://discord.com/api/webhooks/CCC/DDD"}
```

## 3. Clone and deploy

```sh
./setup.sh
```

If your checkout does not preserve executable permissions, run `chmod +x setup.sh` once.

The setup script will:

1. Install the local Wrangler CLI.
2. Validate the Ed token and load its available courses.
3. Show a checkbox-style course list; toggle courses by number and press Enter to confirm.
4. Use the saved or prompted Discord webhook for every selected course.
5. Run the test suite.
6. Open Cloudflare authentication if needed.
7. Create a Workers KV namespace and add its ID to `wrangler.jsonc`.
8. Upload both secrets and deploy the Worker with its five-minute schedule.

## Test the Discord webhook

Send one test embed to the webhook saved in `.env` or `.dev.vars`:

```sh
./test-ping
```

Mentions are disabled in the test payload. Validate the configuration without sending anything with `./test-ping --dry-run`, or provide a custom message with `./test-ping "Deployment is ready"`.

## Acknowledgements

EdToDiscord was inspired by [bachtran02/ed-discohook](https://github.com/bachtran02/ed-discohook), redesigned to run on Cloudflare Workers without the overhead of operating your own server.
