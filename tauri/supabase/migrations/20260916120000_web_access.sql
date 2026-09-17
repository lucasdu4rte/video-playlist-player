create table public.app_owner (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null references auth.users on delete cascade
);

create table public.allowed_emails (
  email text primary key check (email = lower(email))
);

create table public.libraries (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  on_web boolean not null default false,
  last_opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.library_trees (
  library_id uuid primary key references public.libraries on delete cascade,
  tree jsonb not null,
  scanned_at timestamptz not null default now()
);

create table public.hosts (
  owner_id uuid primary key default auth.uid() references auth.users on delete cascade,
  url text not null,
  updated_at timestamptz not null default now()
);

create table public.video_state (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  library_id uuid not null references public.libraries on delete cascade,
  rel_path text not null check (
    rel_path <> ''
    and rel_path !~ '^/'
    and rel_path !~ '(^|/)\.\.(/|$)'
    and position(E'\\' in rel_path) = 0
  ),
  watched boolean not null default false,
  position double precision,
  duration double precision,
  updated_at timestamptz not null,
  synced_at timestamptz not null default now(),
  primary key (user_id, library_id, rel_path)
);

create table public.notes (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  library_id uuid not null references public.libraries on delete cascade,
  rel_path text not null check (
    rel_path <> ''
    and rel_path !~ '^/'
    and rel_path !~ '(^|/)\.\.(/|$)'
    and position(E'\\' in rel_path) = 0
  ),
  text text not null,
  updated_at timestamptz not null,
  synced_at timestamptz not null default now(),
  primary key (user_id, library_id, rel_path)
);

create index video_state_pull on public.video_state (user_id, synced_at);
create index notes_pull on public.notes (user_id, synced_at);

-- security definer: callers must not be able to read app_owner or allowed_emails themselves.
create function public.is_owner() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.app_owner where user_id = auth.uid());
$$;

create function public.is_allowed() returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.is_owner()
    or exists (
      select 1 from auth.users u
      join public.allowed_emails a on a.email = lower(u.email)
      where u.id = auth.uid() and u.email_confirmed_at is not null
    );
$$;

alter table public.app_owner enable row level security;
alter table public.allowed_emails enable row level security;
alter table public.libraries enable row level security;
alter table public.library_trees enable row level security;
alter table public.hosts enable row level security;
alter table public.video_state enable row level security;
alter table public.notes enable row level security;

create policy "owner manages libraries" on public.libraries for all to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_owner()))
  with check (owner_id = (select auth.uid()) and (select public.is_owner()));

create policy "allowed users read shared libraries" on public.libraries for select to authenticated
  using (on_web and (select public.is_allowed()));

-- The subquery runs under the libraries policies, so a tree is visible exactly when its library is.
create policy "trees follow library visibility" on public.library_trees for select to authenticated
  using (exists (select 1 from public.libraries l where l.id = library_id));

create policy "owner manages trees" on public.library_trees for all to authenticated
  using (exists (select 1 from public.libraries l where l.id = library_id and l.owner_id = (select auth.uid())) and (select public.is_owner()))
  with check (exists (select 1 from public.libraries l where l.id = library_id and l.owner_id = (select auth.uid())) and (select public.is_owner()));

create policy "allowed users read hosts" on public.hosts for select to authenticated
  using ((select public.is_allowed()));

create policy "owner manages host" on public.hosts for all to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_owner()))
  with check (owner_id = (select auth.uid()) and (select public.is_owner()));

create policy "own video state" on public.video_state for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_allowed()))
  with check (
    user_id = (select auth.uid()) and (select public.is_allowed())
    and exists (select 1 from public.libraries l where l.id = library_id)
  );

create policy "own notes" on public.notes for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_allowed()))
  with check (
    user_id = (select auth.uid()) and (select public.is_allowed())
    and exists (select 1 from public.libraries l where l.id = library_id)
  );

-- PostgREST upserts cannot carry a conditional WHERE, so last-write-wins lives here.
create function public.sync_video_state(rows jsonb) returns void
language sql security invoker set search_path = ''
as $$
  insert into public.video_state as v (user_id, library_id, rel_path, watched, position, duration, updated_at)
  select distinct on (r.library_id, r.rel_path)
    auth.uid(), r.library_id, r.rel_path, r.watched, r.position, r.duration, r.updated_at
  from jsonb_to_recordset(rows) as r(
    library_id uuid, rel_path text, watched boolean,
    position double precision, duration double precision, updated_at timestamptz
  )
  order by r.library_id, r.rel_path, r.updated_at desc
  on conflict (user_id, library_id, rel_path) do update
    set watched = excluded.watched,
        position = excluded.position,
        duration = excluded.duration,
        updated_at = excluded.updated_at,
        synced_at = now()
    where excluded.updated_at > v.updated_at;
$$;

create function public.sync_notes(rows jsonb) returns void
language sql security invoker set search_path = ''
as $$
  insert into public.notes as n (user_id, library_id, rel_path, text, updated_at)
  select distinct on (r.library_id, r.rel_path)
    auth.uid(), r.library_id, r.rel_path, r.text, r.updated_at
  from jsonb_to_recordset(rows) as r(library_id uuid, rel_path text, text text, updated_at timestamptz)
  order by r.library_id, r.rel_path, r.updated_at desc
  on conflict (user_id, library_id, rel_path) do update
    set text = excluded.text,
        updated_at = excluded.updated_at,
        synced_at = now()
    where excluded.updated_at > n.updated_at;
$$;

-- Keyset paging for pull: offset paging would skip or repeat rows while
-- another device writes concurrently, since rows keep shifting under it.
create function public.pull_video_state(since timestamptz, after_library uuid, after_path text, max_rows int)
returns table (
  library_id uuid, rel_path text, watched boolean,
  "position" double precision, duration double precision,
  updated_at timestamptz, synced_at timestamptz
)
language sql stable security invoker set search_path = ''
as $$
  select v.library_id, v.rel_path, v.watched, v.position, v.duration, v.updated_at, v.synced_at
  from public.video_state v
  where v.user_id = auth.uid()
    and (v.synced_at, v.library_id, v.rel_path) > (
      since,
      coalesce(after_library, '00000000-0000-0000-0000-000000000000'::uuid),
      coalesce(after_path, '')
    )
  order by v.synced_at, v.library_id, v.rel_path
  limit max_rows;
$$;

create function public.pull_notes(since timestamptz, after_library uuid, after_path text, max_rows int)
returns table (
  library_id uuid, rel_path text, text text, updated_at timestamptz, synced_at timestamptz
)
language sql stable security invoker set search_path = ''
as $$
  select n.library_id, n.rel_path, n.text, n.updated_at, n.synced_at
  from public.notes n
  where n.user_id = auth.uid()
    and (n.synced_at, n.library_id, n.rel_path) > (
      since,
      coalesce(after_library, '00000000-0000-0000-0000-000000000000'::uuid),
      coalesce(after_path, '')
    )
  order by n.synced_at, n.library_id, n.rel_path
  limit max_rows;
$$;

revoke execute on function public.is_owner, public.is_allowed, public.sync_video_state, public.sync_notes, public.pull_video_state, public.pull_notes from public, anon;
grant execute on function public.is_owner, public.is_allowed, public.sync_video_state, public.sync_notes, public.pull_video_state, public.pull_notes to authenticated;
