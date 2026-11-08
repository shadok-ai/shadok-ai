import assert from "node:assert/strict";
import test from "node:test";
import {
  LINKEDIN_VERSION, LinkedInError, MAX_COMMENTARY, createPost, escapeCommentary, fetchMember, postTextVerdict, uploadImage,
} from "../src/linkedin.js";

type Call = { url: string; init: RequestInit };
function stub(responses: Response[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return responses.shift()!;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("escapeCommentary escapes each reserved char once and nothing else", () => {
  assert.equal(
    escapeCommentary("Launch (beta) #shadok @Ada 50% *new*"),
    "Launch \\(beta\\) \\#shadok \\@Ada 50% \\*new\\*",
  );
  for (const c of "\\|{}@[]()<>#*_~") assert.equal(escapeCommentary(c), "\\" + c);
  assert.equal(escapeCommentary("Café déjà vu 🚀 — ok."), "Café déjà vu 🚀 — ok.");
});

test("postTextVerdict refuses empty and over-length text with a sentence", () => {
  assert.deepEqual(postTextVerdict("  \n"), { ok: false, reason: "The post is empty." });
  assert.deepEqual(postTextVerdict("a".repeat(MAX_COMMENTARY)), { ok: true });
  assert.deepEqual(postTextVerdict("a".repeat(3001)), { ok: false, reason: "The post is 3,001 characters; LinkedIn allows 3,000." });
});

test("createPost sends the exact body and headers and reads the urn from x-restli-id", async () => {
  const { fn, calls } = stub([new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:123" } })]);
  const r = await createPost("tok", { authorUrn: "urn:li:person:abc", text: "Hi #there", imageUrn: "urn:li:image:9" }, fn);
  assert.deepEqual(r, { urn: "urn:li:share:123", url: "https://www.linkedin.com/feed/update/urn:li:share:123/" });
  assert.equal(calls[0].url, "https://api.linkedin.com/rest/posts");
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(h["LinkedIn-Version"], LINKEDIN_VERSION);
  assert.equal(h["X-Restli-Protocol-Version"], "2.0.0");
  assert.equal(h.Authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    author: "urn:li:person:abc",
    commentary: "Hi \\#there",
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
    content: { media: { id: "urn:li:image:9" } },
  });
});

test("createPost without an image carries no content", async () => {
  const { fn, calls } = stub([new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:1" } })]);
  await createPost("tok", { authorUrn: "urn:li:person:a", text: "x" }, fn);
  assert.equal("content" in JSON.parse(String(calls[0].init.body)), false);
});

test("a 401 is a LinkedInError with expired, and never carries the token", async () => {
  const { fn } = stub([new Response('{"message":"bad"}', { status: 401 })]);
  await assert.rejects(createPost("tok-secret", { authorUrn: "u", text: "x" }, fn), (e: unknown) => {
    assert.ok(e instanceof LinkedInError);
    assert.equal(e.status, 401);
    assert.equal(e.expired, true);
    assert.ok(!e.message.includes("tok-secret"));
    return true;
  });
  const { fn: fn2 } = stub([new Response("x".repeat(1000), { status: 500 })]);
  await assert.rejects(createPost("t", { authorUrn: "u", text: "x" }, fn2), (e: unknown) => {
    assert.ok(e instanceof LinkedInError);
    assert.equal(e.expired, false);
    assert.ok(e.message.length < 400);
    return true;
  });
});

test("a 201 without x-restli-id is an error", async () => {
  const { fn } = stub([new Response(null, { status: 201 })]);
  await assert.rejects(createPost("t", { authorUrn: "u", text: "x" }, fn), LinkedInError);
});

test("fetchMember reads sub and name from userinfo", async () => {
  const { fn, calls } = stub([new Response(JSON.stringify({ sub: "abc", name: "Ada L" }), { status: 200 })]);
  assert.deepEqual(await fetchMember("tok", fn), { sub: "abc", name: "Ada L" });
  assert.equal(calls[0].url, "https://api.linkedin.com/v2/userinfo");
  await assert.rejects(fetchMember("t", stub([new Response("", { status: 401 })]).fn), (e: unknown) => e instanceof LinkedInError && e.expired);
});

test("uploadImage initializes then PUTs the bytes and returns the image urn", async () => {
  const { fn, calls } = stub([
    new Response(JSON.stringify({ value: { uploadUrl: "https://up.example/x", image: "urn:li:image:77" } }), { status: 200 }),
    new Response(null, { status: 201 }),
  ]);
  const urn = await uploadImage("tok", "urn:li:person:a", Buffer.from([1, 2, 3]), "image/png", fn);
  assert.equal(urn, "urn:li:image:77");
  assert.equal(calls[0].url, "https://api.linkedin.com/rest/images?action=initializeUpload");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { initializeUploadRequest: { owner: "urn:li:person:a" } });
  assert.equal(calls[1].url, "https://up.example/x");
  assert.equal(calls[1].init.method, "PUT");
});

test("uploadImage refuses other mime types before any request", async () => {
  const { fn, calls } = stub([]);
  await assert.rejects(uploadImage("t", "u", Buffer.alloc(1), "image/webp", fn), /PNG, JPEG or GIF/);
  assert.equal(calls.length, 0);
});
