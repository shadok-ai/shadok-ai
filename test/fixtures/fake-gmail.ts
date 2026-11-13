// A stand-in for what Gmail does with a raw RFC 2822 message: parse it into
// the `format=full` payload tree (`drafts.get`), transfer-encoding decoded and
// re-encoded as base64url in `body.data`, as the API hands it back. It reads
// the subset `buildMime` writes — enough to prove the round trip, not a mail
// parser.

export interface FakePart {
  mimeType: string;
  filename: string;
  headers: { name: string; value: string }[];
  body: { data?: string; size: number };
  parts?: FakePart[];
}

function parseEntity(raw: string): FakePart {
  const cut = raw.indexOf("\r\n\r\n");
  const head = cut < 0 ? raw : raw.slice(0, cut);
  const body = cut < 0 ? "" : raw.slice(cut + 4);
  // Unfold continuation lines, then split name: value.
  const headers = head
    .replace(/\r\n[ \t]+/g, " ")
    .split("\r\n")
    .filter(Boolean)
    .map((l) => ({ name: l.slice(0, l.indexOf(":")), value: l.slice(l.indexOf(":") + 1).trim() }));
  const get = (n: string) => headers.find((h) => h.name.toLowerCase() === n)?.value ?? "";
  const type = get("content-type");
  const mimeType = (type.split(";")[0] || "text/plain").trim();
  const disp = get("content-disposition");
  let filename = "";
  const star = /filename\*=UTF-8''([^;\s]+)/.exec(disp);
  const plain = /filename="((?:[^"\\]|\\.)*)"/.exec(disp);
  if (star) filename = decodeURIComponent(star[1]);
  else if (plain) filename = plain[1].replace(/\\(.)/g, "$1");
  const boundary = /boundary="([^"]+)"/.exec(type)?.[1];
  if (boundary) {
    const chunks = body.split(`--${boundary}`).slice(1, -1).map((c) => c.replace(/^\r\n/, "").replace(/\r\n$/, ""));
    return { mimeType, filename, headers, body: { size: 0 }, parts: chunks.map(parseEntity) };
  }
  const bytes = get("content-transfer-encoding").toLowerCase() === "base64" ? Buffer.from(body.replace(/\s+/g, ""), "base64") : Buffer.from(body, "utf8");
  return { mimeType, filename, headers, body: { data: bytes.toString("base64url"), size: bytes.length } };
}

/** The `message.payload` Gmail would return for this raw message. */
export function gmailPayloadFromMime(mime: string): FakePart {
  return parseEntity(mime);
}

/** The same, from the base64url `raw` a client POSTs. */
export function gmailPayloadFromRaw(raw: string): FakePart {
  return parseEntity(Buffer.from(raw, "base64url").toString("utf8"));
}
