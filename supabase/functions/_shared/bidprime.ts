// ────────────────────────────────────────────────────────────────────────────
// BidPrime adapter — the ONE place that talks to BidPrime.
//
// Config-driven so it flips from mock → live by setting secrets, with NO code
// change. Until BIDPRIME_API_BASE is set it returns bundled sample RFPs so the
// pipeline is fully testable today.
//
// Secrets (supabase secrets set ...):
//   BIDPRIME_API_KEY        the token (bp_...)                    [already set]
//   BIDPRIME_API_BASE       e.g. https://api.bidprime.com/v1     [need from BidPrime]
//   BIDPRIME_LIST_PATH      e.g. /opportunities                  [default below]
//   BIDPRIME_AUTH_HEADER    e.g. Authorization  (default) or X-API-Key
//   BIDPRIME_AUTH_SCHEME    e.g. Bearer         (default) or "" for raw key
// ────────────────────────────────────────────────────────────────────────────

const KEY = Deno.env.get("BIDPRIME_API_KEY") ?? "";
const BASE = Deno.env.get("BIDPRIME_API_BASE") ?? "";
const LIST_PATH = Deno.env.get("BIDPRIME_LIST_PATH") ?? "/opportunities";
const AUTH_HEADER = Deno.env.get("BIDPRIME_AUTH_HEADER") ?? "Authorization";
const AUTH_SCHEME = Deno.env.get("BIDPRIME_AUTH_SCHEME") ?? "Bearer";

export const isLive = () => Boolean(BASE && KEY);

function authHeaders(): Record<string, string> {
  const val = AUTH_SCHEME ? `${AUTH_SCHEME} ${KEY}` : KEY;
  return { [AUTH_HEADER]: val, "Accept": "application/json" };
}

// Pull a list of opportunities. Returns an array of raw payload objects for the
// normalizer. Tolerant about where the array lives in the response envelope.
export async function fetchOpportunities(): Promise<Record<string, any>[]> {
  if (!isLive()) return sampleRfps();
  const url = BASE.replace(/\/$/, "") + LIST_PATH;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`BidPrime ${res.status} ${res.statusText} @ ${url}`);
  const body = await res.json();
  const arr =
    Array.isArray(body) ? body :
    body.data ?? body.results ?? body.opportunities ?? body.items ?? body.records ?? [];
  return Array.isArray(arr) ? arr : [];
}

// Bundled sample data — a handful of realistic-looking RFPs so the RFP page,
// the Scorecard mirror, and triage all work before the real feed is wired.
export function sampleRfps(): Record<string, any>[] {
  const iso = (days: number) => new Date(Date.now() + days * 864e5).toISOString();
  return [
    { id: "SAMPLE-001", title: "Statewide Tourism Brand Campaign — Creative & Media", agency: "Arizona Office of Tourism", category: "Advertising / Media", url: "https://www.bidprime.com/", posted_at: iso(-2), due_at: iso(18), summary: "Full-service creative, paid media planning/buying, and analytics for a statewide tourism campaign. Estimated annual budget $1.2M." },
    { id: "SAMPLE-002", title: "Website Redesign & CMS Migration", agency: "City of Chandler", category: "Web / Digital", url: "https://www.bidprime.com/", posted_at: iso(-1), due_at: iso(9), summary: "Redesign of the city's public website, accessibility remediation (WCAG 2.1 AA), and migration to a modern CMS." },
    { id: "SAMPLE-003", title: "Public Awareness Campaign — Water Conservation", agency: "Salt River Project", category: "Public Relations", url: "https://www.bidprime.com/", posted_at: iso(-3), due_at: iso(25), summary: "Integrated PR + social campaign to drive residential water-conservation behavior across the metro area." },
    { id: "SAMPLE-004", title: "Photography & Video Production — Annual Report", agency: "Maricopa County", category: "Photo / Video", url: "https://www.bidprime.com/", posted_at: iso(-5), due_at: iso(4), summary: "Photo and video production services for the county's annual report and ongoing communications." },
    { id: "SAMPLE-005", title: "Social Media Management — 12 month retainer", agency: "Arizona Department of Health Services", category: "Social / Retainer", url: "https://www.bidprime.com/", posted_at: iso(-1), due_at: iso(30), summary: "Ongoing social media strategy, content, and community management retainer for a state health agency." },
  ];
}
