# EdToDiscord

I built EdToDiscord because I hated the notification experience in Ed. I would get a bunch of emails every day, but each email only showed the course title and no useful preview of the post. I still had to open Ed just to find out whether an announcement mattered.

EdToDiscord checks Ed every five minutes and sends useful announcements to Discord instead. The Discord message includes the course, category, author, post title, content preview, and a link to the original thread.

It runs as a Cloudflare Worker, so there is no server or Docker container to keep running.

![EdToDiscord desktop notification](docs/desktop-notification.png)

![EdToDiscord message in Discord](docs/discord-message.png)

## What gets posted

EdToDiscord sends:

- Public announcements
- Public posts and questions written by users with the `staff` or `admin` course role

It never sends private threads. Student posts are ignored unless the thread is an announcement.

The first run saves the newest thread in each selected course without posting anything. After that, new matching threads are sent in order. A SHA-256 cursor for each course is stored in Workers KV so the same posts are not sent every five minutes.

## Create a Discord webhook

1. Open the Discord channel settings
2. Go to **Integrations → Webhooks**
3. Create a webhook and copy its URL

Keep the URL private. Anyone with it can post to that channel

## Create an Ed API token

1. Open [Ed API Token Settings](https://edstem.org/us/settings/api-tokens)
2. Create a token and copy it
3. Keep it private, just like the Discord webhook URL

## Deploy

Clone the repository and run the setup script:

```sh
git clone https://github.com/neilthomass/ed-to-discord.git
cd ed-to-discord
./setup.sh
```

The script will:

1. Ask for your Ed token and Discord webhook if they are not already in `.env`.
2. Load the courses available to your Ed account.
3. Show a checkbox-style list of courses.
4. Let you toggle courses by entering numbers such as `1,3`.
5. Use Enter to confirm your selection.
6. Run the tests.
7. Sign in to Cloudflare if needed.
8. Create the KV namespace and deploy the Worker.

The Worker runs every five minutes after deployment. The first scheduled run only initializes its cursors, so it will not dump old posts into Discord.

## Acknowledgements

EdToDiscord was inspired by [bachtran02/ed-discohook](https://github.com/bachtran02/ed-discohook), redesigned to run on Cloudflare Workers without the overhead of operating your own server.
