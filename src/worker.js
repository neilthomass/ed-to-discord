const ED_API_BASE = "https://us.edstem.org";
const ED_WEB_BASE = "https://edstem.org/us";
const ED_ICON = "https://edstem.org/favicon.ico";
const AVATAR_BASE = "https://static.us.edusercontent.com/avatars/";
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const STAFF_ROLES = new Set(["admin", "staff"]);

export default {
  async scheduled(_controller, env) {
    await poll(env);
  },

  async fetch() {
    return Response.json({
      service: "EdToDiscord",
      status: "ok",
      schedule: "every 5 minutes",
    });
  },
};

export async function poll(env, fetcher = fetch) {
  validateEnv(env);
  const webhooks = parseWebhooks(env.DISCORD_WEBHOOKS);
  const courses = await getCourses(env.ED_API_TOKEN, fetcher);

  const results = await Promise.all(
    Object.entries(webhooks).map(async ([courseId, webhookUrl]) => {
      const course = courses.find((item) => String(item.id) === courseId);
      if (!course) {
        throw new Error(`Course ${courseId} is not available to this Ed API token`);
      }
      return pollCourse({ course, webhookUrl, env, fetcher });
    }),
  );

  console.log(JSON.stringify({ event: "poll.complete", courses: results }));
  return results;
}

export async function pollCourse({ course, webhookUrl, env, fetcher = fetch }) {
  const key = `last-seen:${course.id}`;
  const cursor = await env.LAST_SEEN.get(key, "json");
  const firstPage = await listThreads(course.id, env.ED_API_TOKEN, 0, fetcher);

  if (firstPage.length === 0) {
    return { courseId: course.id, seen: 0, posted: 0 };
  }

  if (!cursor?.hash) {
    await saveCursor(env.LAST_SEEN, key, course.id, firstPage[0]);
    console.log(JSON.stringify({ event: "course.seeded", courseId: course.id }));
    return { courseId: course.id, seeded: true, seen: 0, posted: 0 };
  }

  const threads = await collectNewThreads({
    courseId: course.id,
    token: env.ED_API_TOKEN,
    cursorHash: cursor.hash,
    cursorNumber: cursor.threadNumber,
    firstPage,
    fetcher,
  });

  let posted = 0;
  for (const summary of threads.reverse()) {
    if (!summary.is_private) {
      const { thread, users } = await getThread(summary.id, env.ED_API_TOKEN, fetcher);
      const author = users.find((user) => String(user.id) === String(thread.user_id)) ?? thread.user ?? null;

      if (!thread.is_private && shouldForward(thread, author)) {
        await postToDiscord(webhookUrl, buildDiscordPayload(thread, author, course), fetcher);
        posted += 1;
      }
    }

    // Advance only after the thread has either been safely ignored or delivered.
    await saveCursor(env.LAST_SEEN, key, course.id, summary);
  }

  return { courseId: course.id, seen: threads.length, posted };
}

export function shouldForward(thread, author) {
  return thread.type === "announcement" || STAFF_ROLES.has(author?.course_role?.toLowerCase());
}

export function buildDiscordPayload(thread, author, course) {
  const anonymous = thread.is_anonymous;
  const authorName = anonymous ? "Anonymous User" : (author?.name ?? "Unknown User");
  const role = anonymous ? "" : author?.course_role;
  const category = [thread.category, thread.subcategory, thread.subsubcategory]
    .filter(Boolean)
    .join(" • ");
  const footer = { text: truncate(role ? `${authorName} (${capitalize(role)})` : authorName, 2048) };

  if (!anonymous && author?.avatar) {
    footer.icon_url = AVATAR_BASE + author.avatar;
  }

  return {
    username: "Ed",
    avatar_url: ED_ICON,
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: truncate(`#${thread.number} ${thread.title}`, 256),
        description: truncate(thread.document || "(No text content)", 4096),
        url: `${ED_WEB_BASE}/courses/${thread.course_id}/discussion/${thread.id}`,
        color: embedColor(thread.type),
        author: {
          name: truncate([course.code, category].filter(Boolean).join(" • "), 256),
          url: `${ED_WEB_BASE}/courses/${thread.course_id}/discussion`,
        },
        footer,
        timestamp: validTimestamp(thread.created_at),
      },
    ],
  };
}

export async function threadHash(courseId, threadId) {
  const bytes = new TextEncoder().encode(`${courseId}:${threadId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function collectNewThreads({ courseId, token, cursorHash, cursorNumber, firstPage, fetcher }) {
  const collected = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const threads = page === 0
      ? firstPage
      : await listThreads(courseId, token, page * PAGE_SIZE, fetcher);

    for (const thread of threads) {
      if ((await threadHash(courseId, thread.id)) === cursorHash) {
        return collected;
      }
      // A deleted cursor thread cannot be found by hash. Course thread numbers are
      // monotonic, so this fallback resumes safely without replaying old threads.
      if (Number.isFinite(cursorNumber) && thread.number <= cursorNumber) {
        return collected;
      }
      collected.push(thread);
    }

    if (threads.length < PAGE_SIZE) break;
  }

  throw new Error(
    `Saved cursor for course ${courseId} was not found in the newest ${MAX_PAGES * PAGE_SIZE} threads; refusing to replay old posts`,
  );
}

async function getCourses(token, fetcher) {
  const payload = await edRequest("/api/user", token, fetcher);
  return (payload.courses ?? []).map((entry) => entry.course ?? entry);
}

async function listThreads(courseId, token, offset, fetcher) {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset), sort: "new" });
  const payload = await edRequest(`/api/courses/${courseId}/threads?${query}`, token, fetcher);
  return Array.isArray(payload) ? payload : (payload.threads ?? []);
}

async function getThread(threadId, token, fetcher) {
  const payload = await edRequest(`/api/threads/${threadId}`, token, fetcher);
  if (!payload.thread) throw new Error(`Ed returned no thread for ${threadId}`);
  return { thread: payload.thread, users: payload.users ?? [] };
}

async function edRequest(path, token, fetcher) {
  const authorization = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  const response = await fetcher(ED_API_BASE + path, {
    headers: { Authorization: authorization, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Ed request ${path} failed (${response.status}): ${truncate(await response.text(), 500)}`);
  }
  return response.json();
}

async function postToDiscord(webhookUrl, payload, fetcher) {
  const response = await fetcher(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Discord webhook failed (${response.status}): ${truncate(await response.text(), 500)}`);
  }
}

async function saveCursor(kv, key, courseId, thread) {
  await kv.put(key, JSON.stringify({
    hash: await threadHash(courseId, thread.id),
    threadNumber: thread.number,
  }));
}

function parseWebhooks(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("DISCORD_WEBHOOKS must be valid JSON");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.keys(parsed).length === 0) {
    throw new Error("DISCORD_WEBHOOKS must map at least one Ed course ID to a Discord webhook URL");
  }
  for (const [courseId, url] of Object.entries(parsed)) {
    if (!/^\d+$/.test(courseId) || typeof url !== "string" || !url.startsWith("https://")) {
      throw new Error(`Invalid course ID or webhook URL for ${courseId}`);
    }
  }
  return parsed;
}

function validateEnv(env) {
  if (!env.ED_API_TOKEN) throw new Error("Missing ED_API_TOKEN secret");
  if (!env.DISCORD_WEBHOOKS) throw new Error("Missing DISCORD_WEBHOOKS secret");
  if (!env.LAST_SEEN) throw new Error("Missing LAST_SEEN KV binding");
}

function embedColor(type) {
  if (type === "announcement") return 0xfffb55;
  if (type === "question") return 0xe06ce0;
  if (type === "post") return 0x66a2ff;
  return 0x4dffa6;
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function capitalize(value) {
  const text = String(value ?? "");
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function validTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}
