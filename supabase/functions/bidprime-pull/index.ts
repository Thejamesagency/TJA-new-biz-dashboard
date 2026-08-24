// bidprime-pull — fetch opportunities from BidPrime (or bundled samples until
// the API is configured), normalize, and upsert into public.rfps.
// Invoke manually (GET/POST) or on a schedule (pg_cron / Supabase scheduled fn).

import { fetchOpportunities, isLive } from "../_shared/bidprime.ts";
import { normalizeRfp } from "../_shared/normalize.ts";
import { upsertRfps, cors } from "../_shared/db.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const raw = await fetchOpportunities();
    const rows = raw.map(normalizeRfp).filter((r) => r.title);
    const n = await upsertRfps(rows);
    return new Response(
      JSON.stringify({ ok: true, source: isLive() ? "bidprime" : "sample", ingested: n }),
      { headers: { ...cors, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
