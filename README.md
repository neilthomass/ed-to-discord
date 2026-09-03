# EdToDiscord

I built EdToDiscord because I hated the notification experience in Ed. I would get a bunch of emails every day, but each email only showed the course title and no useful preview of the post. I still had to open Ed just to find out whether an announcement mattered.

EdToDiscord checks Ed every five minutes and sends useful announcements to Discord instead. The Discord message includes the course, category, author, post title, content preview, and a link to the original thread.

It runs as a Cloudflare Worker, so there is no server or Docker container to keep running.

For a normal personal setup, it is free to run. Polling every five minutes is only 288 Worker runs per day, well below Cloudflare's [Workers free limit](https://developers.cloudflare.com/workers/platform/limits/), and the small cursor cache fits within the [Workers KV free limits](https://developers.cloudflare.com/kv/platform/limits/).

## Preview

<img src="docs/desktop-notification.webp" alt="Separate Discord channels for each Ed course" width="300">

<img src="docs/discord-message.webp" alt="An Ed course post delivered to its Discord channel" width="620">

## What gets posted

EdToDiscord sends:

- Public announcements
- Public posts and questions written by users with the `staff` or `admin` course role

It never sends private threads. Student posts are ignored unless the thread is an announcement.

The first run saves the newest thread in each selected course without posting anything. After that, new matching threads are sent in order. A SHA-256 cursor for each course is stored in Workers KV so the same posts are not sent every five minutes.

## Setup

1. Create one Discord channel for each Ed course you want to follow. In each channel, open **Edit Channel → Integrations → Webhooks**, create a webhook, and copy its URL.
2. Open [Ed API Token Settings](https://edstem.org/us/settings/api-tokens), create a token, and copy it.
3. Clone the repository and run the setup script:

   ```sh
   git clone https://github.com/neilthomass/ed-to-discord.git
   cd ed-to-discord
   ./setup.sh
   ```

The setup script asks for the Ed token, loads your available courses, and shows a checkbox-style course list. After you choose the courses, it asks for each course's Discord webhook. Each course is therefore delivered only to its corresponding channel. It then runs the tests, signs in to Cloudflare if needed, creates the KV namespace, and deploys the Worker.

For repeat deployments, you can put the mapping in the git-ignored `.env` file and setup will reuse it:

```dotenv
DISCORD_WEBHOOKS='{"12345":"https://discord.com/api/webhooks/...","67890":"https://discord.com/api/webhooks/..."}'
```

After deployment, the Worker runs every five minutes. Its first run only initializes the cursors, so it does not post old threads.

## Acknowledgements

EdToDiscord was inspired by [bachtran02/ed-discohook](https://github.com/bachtran02/ed-discohook), redesigned to run on Cloudflare Workers without the overhead of operating your own server.
