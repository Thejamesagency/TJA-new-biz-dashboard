// bidprime-webhook — receives pushed opportunities from BidPrime.
// Point BidPrime's webhook at this function's URL. If BIDPRIME_WEBHOOK_SECRET
// is set, the raw body is HMAC-SHA256 verified against the x-bidprime-signature
// header (hex). Accepts a single object or an array (or {data:[...]}).

import { normalizeRfp } from "../_shared/normalize.ts";
import { upsertRfps, cors } from "../_shared/db.ts";

const SECRET = Deno.env.get("BIDPRIME_WEBHOOK_SECRET") ?? "";

async function verify(rawBody: string, sigHeader: string | null): Promise<boolean> {
  if (!SECRET) return true;                 // no secret configured → skip (set it once BidPrime gives you one)
  if (!sigHeader) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = sigHeader.replace(/^sha256=/i, "").trim().toLowerCase();
  // constant-time-ish compare
  if (given.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "POST only" }), {
      status: 405, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  try {
    const rawBody = await req.text();
    const ok = await verify(rawBody, req.headers.get("x-bidprime-signature"));
    if (!ok) {
      return new Response(JSON.stringify({ ok: false, error: "bad signature" }), {
        status: 401, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const body = rawBody ? JSON.parse(rawBody) : {};
    const list = Array.isArray(body) ? body : (body.data ?? body.opportunities ?? [body]);
    const rows = (Array.isArray(list) ? list : [list]).map(normalizeRfp).filter((r) => r.title);
    const n = await upsertRfps(rows);
    return new Response(JSON.stringify({ ok: true, ingested: n }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
