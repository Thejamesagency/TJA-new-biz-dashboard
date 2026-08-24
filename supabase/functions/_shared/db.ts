// Shared helpers: CORS + a tiny service-role upsert into public.rfps via the
// Supabase REST API (no npm deps — Edge runtime fetch only).

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bidprime-signature",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

import type { RfpRow } from "./normalize.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Upsert rows keyed by external_id. Rows without an external_id are inserted.
export async function upsertRfps(rows: RfpRow[]): Promise<number> {
  if (!rows.length) return 0;
  const payload = rows.map((r) => ({ ...r, updated_at: new Date().toISOString() }));
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/rfps?on_conflict=external_id`,
    {
      method: "POST",
      headers: {
        "apikey": SERVICE_KEY,
        "Authorization": `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) throw new Error(`upsert failed ${res.status}: ${await res.text()}`);
  return rows.length;
}
