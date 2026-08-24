-- RFP feed — the source of truth for incoming BidPrime opportunities.
-- Thin metadata + a deep link + optional score JSON. NEVER the file or full
-- document text (licensing + size). Written only by Edge Functions using the
-- service-role key; the RFP page reads it with the anon key (select-only).

create table if not exists public.rfps (
  id           uuid primary key default gen_random_uuid(),
  external_id  text unique,                 -- BidPrime opportunity id (dedupe key)
  title        text not null,
  agency       text,
  category     text,
  source_url   text,                        -- deep link back to the BidPrime opportunity page
  posted_at    timestamptz,
  due_at       timestamptz,
  summary      text,                         -- short summary/context only (no full doc text)
  raw          jsonb,                         -- the normalized subset we ingested (debugging)
  score        jsonb,                         -- optional scoring result { tier, pants, investment, ... }
  tier         text,                          -- convenience mirror of score->>'tier'
  received_at  timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists rfps_due_idx      on public.rfps (due_at);
create index if not exists rfps_received_idx on public.rfps (received_at desc);
create index if not exists rfps_tier_idx     on public.rfps (tier);

-- keep updated_at fresh on any change
create or replace function public.rfps_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists rfps_touch on public.rfps;
create trigger rfps_touch before update on public.rfps
  for each row execute function public.rfps_touch_updated_at();

-- RLS: anon may SELECT only. No insert/update/delete policies exist, so the
-- only writers are Edge Functions (service_role bypasses RLS).
alter table public.rfps enable row level security;

drop policy if exists "rfps anon read" on public.rfps;
create policy "rfps anon read" on public.rfps
  for select to anon using (true);
