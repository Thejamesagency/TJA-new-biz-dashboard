-- Full-dashboard data on Supabase (migration from Firebase Firestore).
-- Mirrors the Firestore model but per-key instead of one 1MB doc: each synced
-- localStorage key becomes its own row, keyed by (workspace_id, key). Removes
-- the single-document size ceiling entirely.

create table if not exists public.workspace_data (
  workspace_id text        not null,
  key          text        not null,
  value        jsonb,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, key)
);

-- Who may WRITE each workspace (replaces the per-workspace Firestore rules).
create table if not exists public.workspace_owners (
  workspace_id text primary key,
  owner_email  text not null
);

insert into public.workspace_owners (workspace_id, owner_email) values
  ('tja-main',     'cameron@thejamesagency.com'),
  ('tja-taylor',   'taylor@thejamesagency.com'),
  ('tja-sheridan', 'sheridan@thejamesagency.com')
on conflict (workspace_id) do update set owner_email = excluded.owner_email;

create or replace function public.is_workspace_owner(ws text)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.workspace_owners o
    where o.workspace_id = ws
      and lower(o.owner_email) = lower(coalesce(auth.jwt() ->> 'email',''))
  );
$$;

alter table public.workspace_data enable row level security;

-- READ: any verified @thejamesagency.com account (matches today's view-all model).
drop policy if exists "wsdata select" on public.workspace_data;
create policy "wsdata select" on public.workspace_data for select to authenticated
  using ( lower(coalesce(auth.jwt() ->> 'email','')) like '%@thejamesagency.com' );

-- WRITE: only the workspace's owner email.
drop policy if exists "wsdata insert" on public.workspace_data;
create policy "wsdata insert" on public.workspace_data for insert to authenticated
  with check ( public.is_workspace_owner(workspace_id) );

drop policy if exists "wsdata update" on public.workspace_data;
create policy "wsdata update" on public.workspace_data for update to authenticated
  using ( public.is_workspace_owner(workspace_id) )
  with check ( public.is_workspace_owner(workspace_id) );

drop policy if exists "wsdata delete" on public.workspace_data;
create policy "wsdata delete" on public.workspace_data for delete to authenticated
  using ( public.is_workspace_owner(workspace_id) );

-- keep updated_at fresh
create or replace function public.workspace_data_touch()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists wsdata_touch on public.workspace_data;
create trigger wsdata_touch before update on public.workspace_data
  for each row execute function public.workspace_data_touch();
