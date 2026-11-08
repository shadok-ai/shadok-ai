// LinkedIn client: member lookup, image upload, post creation. Every call goes
// through an injected fetch so tests never touch the network. The token is
// only ever put in an Authorization header; it never enters an error message.
// Shapes confirmed against Microsoft Learn (Posts API, Images API, little Text
// Format) on 2026-11-08.

// 202511 is sunset on 2026-11-16; 202610 is the newest version the docs list.
export const LINKEDIN_VERSION = "202610";
export const MAX_COMMENTARY = 3000;

const API = "https://api.linkedin.com";
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif"];

export type FetchFn = typeof fetch;

export class LinkedInError extends Error {
  status: number;
  /** A 401 means the token is no longer accepted: the account must be reconnected. */
  expired: boolean;
  constructor(message: string, status: number) {
    super(message);
    this.name = "LinkedInError";
    this.status = status;
    this.expired = status === 401;
  }
}

// "little" text reserved characters: \ | { } @ [ ] ( ) < > # * _ ~
export function escapeCommentary(text: string): string {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, "\\$&");
}

export function postTextVerdict(text: string): { ok: true } | { ok: false; reason: string } {
  if (!text.trim()) return { ok: false, reason: "The post is empty." };
  const n = [...text].length;
  if (n > MAX_COMMENTARY) {
    return { ok: false, reason: `The post is ${n.toLocaleString("en-US")} characters; LinkedIn allows ${MAX_COMMENTARY.toLocaleString("en-US")}.` };
  }
  return { ok: true };
}

function restHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "LinkedIn-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
    "Content-Type": "application/json",
  };
}

async function failure(what: string, res: Response): Promise<LinkedInError> {
  let body = "";
  try { body = (await res.text()).replace(/\s+/g, " ").trim().slice(0, 300); } catch { /* no body */ }
  return new LinkedInError(`LinkedIn ${what} failed (${res.status})${body ? `: ${body}` : ""}`, res.status);
}

export async function fetchMember(token: string, fetchFn: FetchFn): Promise<{ sub: string; name: string }> {
  const res = await fetchFn(`${API}/v2/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw await failure("profile lookup", res);
  const j = (await res.json()) as { sub?: string; name?: string };
  if (!j.sub) throw new LinkedInError("LinkedIn profile lookup returned no member id.", res.status);
  return { sub: j.sub, name: j.name ?? "" };
}

export async function uploadImage(token: string, authorUrn: string, bytes: Buffer, mime: string, fetchFn: FetchFn): Promise<string> {
  if (!IMAGE_MIMES.includes(mime)) throw new Error(`LinkedIn accepts PNG, JPEG or GIF images, not ${mime}.`);
  const init = await fetchFn(`${API}/rest/images?action=initializeUpload`, {
    method: "POST",
    headers: restHeaders(token),
    body: JSON.stringify({ initializeUploadRequest: { owner: authorUrn } }),
  });
  if (!init.ok) throw await failure("image upload start", init);
  const { value } = (await init.json()) as { value?: { uploadUrl?: string; image?: string } };
  if (!value?.uploadUrl || !value.image) throw new LinkedInError("LinkedIn image upload start returned no upload address.", init.status);
  const put = await fetchFn(value.uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": mime },
    body: new Uint8Array(bytes),
  });
  if (!put.ok) throw await failure("image upload", put);
  return value.image;
}

export async function createPost(
  token: string,
  post: { authorUrn: string; text: string; imageUrn?: string },
  fetchFn: FetchFn,
): Promise<{ urn: string; url: string }> {
  const body: Record<string, unknown> = {
    author: post.authorUrn,
    commentary: escapeCommentary(post.text),
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  if (post.imageUrn) body.content = { media: { id: post.imageUrn } };
  const res = await fetchFn(`${API}/rest/posts`, { method: "POST", headers: restHeaders(token), body: JSON.stringify(body) });
  if (!res.ok) throw await failure("post", res);
  const urn = res.headers.get("x-restli-id");
  if (!urn) throw new LinkedInError("LinkedIn accepted the post but returned no post id.", res.status);
  return { urn, url: `https://www.linkedin.com/feed/update/${urn}/` };
}
