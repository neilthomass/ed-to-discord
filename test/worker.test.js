import test from "node:test";
import assert from "node:assert/strict";

import { buildDiscordPayload, poll, pollCourse, shouldForward, threadHash } from "../src/worker.js";

test("thread hash is stable and scoped to its course", async () => {
  assert.equal(await threadHash(123, 456), await threadHash(123, 456));
  assert.notEqual(await threadHash(123, 456), await threadHash(124, 456));
});

test("announcements and staff posts are forwarded", () => {
  assert.equal(shouldForward({ type: "announcement" }, { course_role: "student" }), true);
  assert.equal(shouldForward({ type: "post" }, { course_role: "staff" }), true);
  assert.equal(shouldForward({ type: "question" }, { course_role: "admin" }), true);
  assert.equal(shouldForward({ type: "post" }, { course_role: "student" }), false);
});

test("Discord embeds are bounded and do not allow mentions", () => {
  const payload = buildDiscordPayload(
    {
      id: 22,
      user_id: 5,
      course_id: 10,
      number: 7,
      title: "A".repeat(300),
      document: "B".repeat(5000),
      category: "General",
      type: "announcement",
      created_at: "2026-01-01T00:00:00Z",
      is_anonymous: false,
    },
    { id: 5, name: "Instructor", course_role: "staff", avatar: "avatar-id" },
    { id: 10, code: "CS101" },
  );

  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.equal(payload.embeds[0].title.length, 256);
  assert.equal(payload.embeds[0].description.length, 4096);
  assert.equal(payload.embeds[0].footer.text, "Instructor (Staff)");
});

test("first course poll seeds KV without posting historical threads", async () => {
  const writes = [];
  const env = {
    ED_API_TOKEN: "token",
    LAST_SEEN: {
      get: async () => null,
      put: async (...args) => writes.push(args),
    },
  };
  const fetcher = async (url, options) => {
    assert.match(url, /\/api\/courses\/10\/threads/);
    assert.equal(options.headers.Authorization, "Bearer token");
    return jsonResponse({ threads: [{ id: 99, number: 12, is_private: false }] });
  };

  const result = await pollCourse({
    course: { id: 10, code: "CS101" },
    webhookUrl: "https://discord.com/api/webhooks/test",
    env,
    fetcher,
  });

  assert.equal(result.seeded, true);
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0][1]).threadNumber, 12);
});

test("multiple staff announcements between polls post oldest first", async () => {
  const posts = [];
  const writes = [];
  const oldHash = await threadHash(10, 1);
  const summaries = [
    { id: 3, number: 3, is_private: false },
    { id: 2, number: 2, is_private: false },
    { id: 1, number: 1, is_private: false },
  ];
  const env = {
    ED_API_TOKEN: "token",
    LAST_SEEN: {
      get: async () => ({ hash: oldHash, threadNumber: 1 }),
      put: async (_key, value) => writes.push(JSON.parse(value)),
    },
  };
  const fetcher = async (url, options = {}) => {
    if (url.includes("/api/courses/10/threads")) return jsonResponse({ threads: summaries });
    if (url.includes("/api/threads/2")) return detailResponse(2, "announcement", "staff", "2026-01-01T00:00:00Z");
    if (url.includes("/api/threads/3")) return detailResponse(3, "announcement", "staff", "2026-01-01T00:03:00Z");
    if (options.method === "POST") {
      posts.push(JSON.parse(options.body).embeds[0].title);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const result = await pollCourse({
    course: { id: 10, code: "CS101" },
    webhookUrl: "https://discord.com/api/webhooks/test",
    env,
    fetcher,
  });

  assert.deepEqual(posts, ["#2 Thread 2", "#3 Thread 3"]);
  assert.deepEqual(writes.map((item) => item.threadNumber), [2, 3]);
  assert.deepEqual(result, { courseId: 10, seen: 2, posted: 2 });
});

test("each course posts only to its configured Discord channel", async () => {
  const deliveries = [];
  const env = {
    ED_API_TOKEN: "token",
    DISCORD_WEBHOOKS: JSON.stringify({
      10: "https://discord.com/api/webhooks/course-10",
      20: "https://discord.com/api/webhooks/course-20",
    }),
    LAST_SEEN: {
      get: async (key) => ({
        hash: await threadHash(Number(key.split(":")[1]), 1),
        threadNumber: 1,
      }),
      put: async () => {},
    },
  };
  const fetcher = async (url, options = {}) => {
    if (url.endsWith("/api/user")) {
      return jsonResponse({ courses: [{ id: 10, code: "CS10" }, { id: 20, code: "CS20" }] });
    }
    const courseMatch = url.match(/\/api\/courses\/(\d+)\/threads/);
    if (courseMatch) {
      const courseId = Number(courseMatch[1]);
      return jsonResponse({ threads: [
        { id: courseId + 1, number: 2, is_private: false },
        { id: 1, number: 1, is_private: false },
      ] });
    }
    const threadMatch = url.match(/\/api\/threads\/(\d+)$/);
    if (threadMatch) {
      const threadId = Number(threadMatch[1]);
      const courseId = threadId - 1;
      return detailResponse(threadId, "announcement", "staff", "2026-01-01T00:00:00Z", courseId);
    }
    if (options.method === "POST") {
      deliveries.push({ url, payload: JSON.parse(options.body) });
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await poll(env, fetcher);

  assert.deepEqual(
    deliveries.map(({ url, payload }) => [url, payload.embeds[0].author.name]),
    [
      ["https://discord.com/api/webhooks/course-10", "CS10 • General"],
      ["https://discord.com/api/webhooks/course-20", "CS20 • General"],
    ],
  );
});

test("private threads are never fetched or posted", async () => {
  const writes = [];
  const env = {
    ED_API_TOKEN: "token",
    LAST_SEEN: {
      get: async () => ({ hash: await threadHash(10, 1), threadNumber: 1 }),
      put: async (_key, value) => writes.push(JSON.parse(value)),
    },
  };
  const fetcher = async (url) => {
    if (url.includes("/api/courses/10/threads")) {
      return jsonResponse({
        threads: [
          { id: 2, number: 2, is_private: true },
          { id: 1, number: 1, is_private: false },
        ],
      });
    }
    throw new Error(`Private thread caused an unexpected request: ${url}`);
  };

  const result = await pollCourse({
    course: { id: 10, code: "CS101" },
    webhookUrl: "https://discord.com/api/webhooks/test",
    env,
    fetcher,
  });

  assert.deepEqual(result, { courseId: 10, seen: 1, posted: 0 });
  assert.equal(writes[0].threadNumber, 2);
});

test("a failed Discord delivery does not advance the cursor", async () => {
  let writes = 0;
  const env = {
    ED_API_TOKEN: "token",
    LAST_SEEN: {
      get: async () => ({ hash: await threadHash(10, 1), threadNumber: 1 }),
      put: async () => { writes += 1; },
    },
  };
  const fetcher = async (url, options = {}) => {
    if (url.includes("/api/courses/10/threads")) {
      return jsonResponse({ threads: [
        { id: 2, number: 2, is_private: false },
        { id: 1, number: 1, is_private: false },
      ] });
    }
    if (url.includes("/api/threads/2")) return detailResponse(2, "announcement", "staff");
    if (options.method === "POST") return new Response("rate limited", { status: 429 });
    throw new Error(`Unexpected request: ${url}`);
  };

  await assert.rejects(
    pollCourse({
      course: { id: 10, code: "CS101" },
      webhookUrl: "https://discord.com/api/webhooks/test",
      env,
      fetcher,
    }),
    /Discord webhook failed \(429\)/,
  );
  assert.equal(writes, 0);
});

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function detailResponse(id, type, courseRole, createdAt = "2026-01-01T00:00:00Z", courseId = 10) {
  return jsonResponse({
    thread: {
      id,
      user_id: 7,
      course_id: courseId,
      number: id,
      title: `Thread ${id}`,
      document: "Body",
      category: "General",
      type,
      created_at: createdAt,
      is_private: false,
      is_anonymous: false,
    },
    users: [{ id: 7, name: "Teacher", course_role: courseRole }],
  });
}
