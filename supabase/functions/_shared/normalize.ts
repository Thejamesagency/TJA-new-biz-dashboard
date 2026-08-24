// ────────────────────────────────────────────────────────────────────────────
// BidPrime payload → rfps row normalizer.
//
// ⚠️ ASSUMPTIONS: BidPrime's API is not publicly documented and we don't yet
// have a real sample payload, so this reads a range of likely field names and
// takes the first that exists. When the real payload arrives, tighten the
// picks below — this is the ONLY file that should need changing.
// ────────────────────────────────────────────────────────────────────────────

export interface RfpRow {
  external_id: string | null;
  title: string;
  agency: string | null;
  category: string | null;
  source_url: string | null;
  posted_at: string | null;
  due_at: string | null;
  summary: string | null;
  raw: Record<string, unknown>;
}

function pick(o: Record<string, any>, keys: string[]): any {
  for (const k of keys) {
    // support dotted paths like "agency.name"
    const v = k.split(".").reduce((acc: any, part) => (acc == null ? acc : acc[part]), o);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function toIso(v: any): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function normalizeRfp(payload: Record<string, any>): RfpRow {
  // Some webhooks wrap the record: {event, data:{...}} — unwrap common shapes.
  const o = (payload.data ?? payload.opportunity ?? payload.record ?? payload) as Record<string, any>;

  const external_id = pick(o, ["id", "opportunity_id", "opportunityId", "bid_id", "bidId", "uuid", "guid"]);
  const title = pick(o, ["title", "name", "opportunity_title", "solicitation_title", "subject"]) ?? "(untitled RFP)";
  const agency = pick(o, ["agency", "agency_name", "agencyName", "buyer", "organization", "entity", "agency.name"]);
  const category = pick(o, ["category", "commodity", "naics", "type", "classification"]);
  const source_url = pick(o, ["url", "link", "permalink", "deep_link", "deepLink", "web_url", "opportunity_url", "href"]);
  const posted_at = toIso(pick(o, ["posted_at", "postedDate", "posted", "published_at", "created_at", "date_posted"]));
  const due_at = toIso(pick(o, ["due_at", "dueDate", "due", "closing_date", "closingDate", "response_due", "deadline", "close_date"]));
  const summary = pick(o, ["summary", "description", "abstract", "synopsis", "excerpt", "details"]);

  return {
    external_id: external_id != null ? String(external_id) : null,
    title: String(title),
    agency: agency != null ? String(agency) : null,
    category: category != null ? String(category) : null,
    source_url: source_url != null ? String(source_url) : null,
    posted_at,
    due_at,
    summary: summary != null ? String(summary).slice(0, 4000) : null, // metadata only, never the full doc
    raw: o,
  };
}
