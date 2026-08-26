-- RFP analytics dimensions + meeting-minutes signals.
-- These power the Trends view: slice RFP activity by industry / service /
-- state / city / season, filtered to the target geography.

alter table public.rfps add column if not exists state          text;
alter table public.rfps add column if not exists city           text;
alter table public.rfps add column if not exists industry       text;
alter table public.rfps add column if not exists service        text;
alter table public.rfps add column if not exists value_estimate numeric;
alter table public.rfps add column if not exists classified_at  timestamptz;  -- when the LLM classifier last ran

create index if not exists rfps_state_idx    on public.rfps (state);
create index if not exists rfps_industry_idx on public.rfps (industry);
create index if not exists rfps_service_idx  on public.rfps (service);

-- Meeting-minutes signals — leading indicators mined from public agenda /
-- minutes documents (before an RFP is issued). Each row = one detected
-- "upcoming need" / "agency shopping for an agency" signal.
create table if not exists public.minutes_signals (
  id             uuid primary key default gen_random_uuid(),
  source_url     text,
  doc_title      text,
  meeting_date   date,
  agency         text,                 -- the entity (a potential ad-targeting prospect)
  state          text,
  city           text,
  industry       text,
  need_summary   text,                 -- what they signalled they need
  looking_for_agency boolean default false,
  confidence     numeric,              -- 0-1, from the extractor
  raw            jsonb,
  received_at    timestamptz not null default now()
);

create index if not exists minutes_state_idx on public.minutes_signals (state);
create index if not exists minutes_date_idx  on public.minutes_signals (meeting_date desc);

alter table public.minutes_signals enable row level security;
drop policy if exists "minutes anon read" on public.minutes_signals;
create policy "minutes anon read" on public.minutes_signals
  for select to anon using (true);
