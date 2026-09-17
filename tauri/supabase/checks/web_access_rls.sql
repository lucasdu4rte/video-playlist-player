\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-00000000000a', 'owner@example.com', now()),
  ('00000000-0000-0000-0000-00000000000b', 'guest@example.com', now()),
  ('00000000-0000-0000-0000-00000000000c', 'stranger@example.com', now()),
  ('00000000-0000-0000-0000-00000000000d', 'unconfirmed@example.com', null);
insert into public.app_owner (user_id) values ('00000000-0000-0000-0000-00000000000a');
insert into public.allowed_emails (email) values ('guest@example.com'), ('unconfirmed@example.com');

-- Owner: no allowed_emails entry, still allowed.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","email":"owner@example.com","role":"authenticated"}';

insert into public.libraries (id, name, on_web) values
  ('10000000-0000-0000-0000-000000000001', 'Shared course', true),
  ('10000000-0000-0000-0000-000000000002', 'Private course', false);
insert into public.library_trees (library_id, tree) values
  ('10000000-0000-0000-0000-000000000001', '[]'),
  ('10000000-0000-0000-0000-000000000002', '[]');
insert into public.hosts (url) values ('https://example.trycloudflare.com');

select public.sync_video_state('[
  {"library_id":"10000000-0000-0000-0000-000000000001","rel_path":"01 Intro.mp4","watched":false,"position":42,"duration":600,"updated_at":"2026-09-16T12:00:00.000Z"}
]');
select public.sync_notes('[
  {"library_id":"10000000-0000-0000-0000-000000000001","rel_path":"01 Intro.mp4","text":"owner secret","updated_at":"2026-09-16T12:00:00.000Z"}
]');

-- LWW: an older write is ignored, a newer one wins.
select public.sync_video_state('[
  {"library_id":"10000000-0000-0000-0000-000000000001","rel_path":"01 Intro.mp4","watched":true,"position":null,"duration":600,"updated_at":"2026-09-16T11:00:00.000Z"}
]');
select 'lww older ignored' as check, watched, position from public.video_state;

select public.sync_video_state('[
  {"library_id":"10000000-0000-0000-0000-000000000001","rel_path":"01 Intro.mp4","watched":true,"position":null,"duration":600,"updated_at":"2026-09-16T13:00:00.000Z"}
]');
select 'lww newer wins' as check, watched, position, updated_at from public.video_state;

select 'owner sees libraries' as check, count(*) from public.libraries;

-- A batch with two rows for the same key must not abort the whole call; the newer row wins.
select public.sync_video_state('[
  {"library_id":"10000000-0000-0000-0000-000000000001","rel_path":"02 Dedupe.mp4","watched":false,"position":1,"duration":600,"updated_at":"2026-09-16T10:00:00.000Z"},
  {"library_id":"10000000-0000-0000-0000-000000000001","rel_path":"02 Dedupe.mp4","watched":true,"position":99,"duration":600,"updated_at":"2026-09-16T14:00:00.000Z"}
]');
select 'dedupe video_state' as check, watched, position, updated_at
  from public.video_state where rel_path = '02 Dedupe.mp4';
do $$ begin
  if not exists (
    select 1 from public.video_state
    where rel_path = '02 Dedupe.mp4' and watched = true and position = 99
  ) then raise exception 'sync_video_state did not keep the newer row of a duplicate batch'; end if;
end $$;

select public.sync_notes('[
  {"library_id":"10000000-0000-0000-0000-000000000001","rel_path":"02 Dedupe.mp4","text":"old","updated_at":"2026-09-16T10:00:00.000Z"},
  {"library_id":"10000000-0000-0000-0000-000000000001","rel_path":"02 Dedupe.mp4","text":"new","updated_at":"2026-09-16T14:00:00.000Z"}
]');
select 'dedupe notes' as check, text, updated_at from public.notes where rel_path = '02 Dedupe.mp4';
do $$ begin
  if not exists (
    select 1 from public.notes where rel_path = '02 Dedupe.mp4' and text = 'new'
  ) then raise exception 'sync_notes did not keep the newer row of a duplicate batch'; end if;
end $$;

-- pull_video_state pages by keyset, not offset. Within one transaction now()
-- is constant, so every earlier row here shares one synced_at; the true
-- keyset boundary is the (synced_at, library_id, rel_path) of the last row
-- already written, not just its synced_at — a tuple comparison still ranks
-- same-timestamp rows by library_id/rel_path, so a bare timestamp floor
-- would re-include them.
select v.synced_at as before_keyset, v.library_id as before_library, v.rel_path as before_path
  from public.video_state v
  where v.user_id = '00000000-0000-0000-0000-00000000000a'::uuid
  order by v.synced_at desc, v.library_id desc, v.rel_path desc
  limit 1;
\gset

insert into public.video_state (library_id, rel_path, watched, updated_at, synced_at) values
  ('10000000-0000-0000-0000-000000000001', 'keyset/a.mp4', false, now(), :'before_keyset'::timestamptz + interval '1 second'),
  ('10000000-0000-0000-0000-000000000001', 'keyset/b.mp4', false, now(), :'before_keyset'::timestamptz + interval '2 second'),
  ('10000000-0000-0000-0000-000000000001', 'keyset/c.mp4', false, now(), :'before_keyset'::timestamptz + interval '3 second');

select 'pull_video_state page 1' as check, rel_path
  from public.pull_video_state(:'before_keyset'::timestamptz, :'before_library'::uuid, :'before_path'::text, 2);
-- A plain top-level query (not a dollar-quoted DO block) is required here so
-- psql still substitutes the :'variable' placeholders captured above. The
-- divisor is a subquery rather than a bare literal so Postgres can't fold
-- "1/0" away at plan time regardless of which branch actually applies.
select 1 / (
  select count(*) from (select 1 where (
    select array_agg(rel_path order by rel_path)
    from public.pull_video_state(:'before_keyset'::timestamptz, :'before_library'::uuid, :'before_path'::text, 2)
  ) = array['keyset/a.mp4', 'keyset/b.mp4']) t
) as assert_pull_video_state_page_1;

-- A real continuation call advances `since` to the last-seen row's own
-- synced_at (as sync.ts's pullSince does) — reusing the original floor here
-- would make every later-synced_at row match on the first tuple component
-- alone, before the (library_id, rel_path) keyset is even considered.
select synced_at as page1_last_synced from public.video_state
  where library_id = '10000000-0000-0000-0000-000000000001' and rel_path = 'keyset/b.mp4';
\gset

select 'pull_video_state page 2' as check, rel_path
  from public.pull_video_state(:'page1_last_synced'::timestamptz, '10000000-0000-0000-0000-000000000001'::uuid, 'keyset/b.mp4', 2);
select 1 / (
  select count(*) from (select 1 where (
    select array_agg(rel_path)
    from public.pull_video_state(:'page1_last_synced'::timestamptz, '10000000-0000-0000-0000-000000000001'::uuid, 'keyset/b.mp4', 2)
  ) = array['keyset/c.mp4']) t
) as assert_pull_video_state_page_2;

-- rel_path CHECK: traversal, absolute paths, empty strings and backslashes are all rejected.
do $$ begin
  insert into public.notes (library_id, rel_path, text, updated_at)
    values ('10000000-0000-0000-0000-000000000001', 'a/../b.mp4', 'x', now());
  raise exception 'rel_path traversal was accepted';
exception when check_violation then null;
end $$;

do $$ begin
  insert into public.notes (library_id, rel_path, text, updated_at)
    values ('10000000-0000-0000-0000-000000000001', '/abs.mp4', 'x', now());
  raise exception 'rel_path absolute path was accepted';
exception when check_violation then null;
end $$;

do $$ begin
  insert into public.notes (library_id, rel_path, text, updated_at)
    values ('10000000-0000-0000-0000-000000000001', '', 'x', now());
  raise exception 'rel_path empty string was accepted';
exception when check_violation then null;
end $$;

do $$ begin
  insert into public.notes (library_id, rel_path, text, updated_at)
    values ('10000000-0000-0000-0000-000000000001', E'..\\..\\secret.mp4', 'x', now());
  raise exception 'rel_path backslash path was accepted';
exception when check_violation then null;
end $$;

-- Guest: allowlisted, sees only on_web libraries and their trees, never the owner's rows.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000b","email":"guest@example.com","role":"authenticated"}';

select 'guest libraries' as check, name from public.libraries;
select 'guest trees' as check, count(*) from public.library_trees;
select 'guest hosts' as check, count(*) from public.hosts;
select 'guest sees owner notes' as check, count(*) from public.notes;
select 'guest sees owner state' as check, count(*) from public.video_state;

select public.sync_notes('[
  {"library_id":"10000000-0000-0000-0000-000000000001","rel_path":"01 Intro.mp4","text":"guest note","updated_at":"2026-09-16T12:30:00.000Z"}
]');
select 'guest own note' as check, text from public.notes;

select 'guest pull_notes' as check, rel_path, text
  from public.pull_notes('1970-01-01T00:00:00Z'::timestamptz, null, null, 100);
do $$ begin
  if (
    select array_agg(text order by text)
    from public.pull_notes('1970-01-01T00:00:00Z'::timestamptz, null, null, 100)
  ) is distinct from array['guest note'] then
    raise exception 'guest pull_notes did not return exactly their own note';
  end if;
end $$;

do $$ begin
  update public.libraries set on_web = false;
  if found then raise exception 'guest updated a library'; end if;
end $$;

do $$ begin
  insert into public.libraries (id, name) values ('10000000-0000-0000-0000-0000000000b1', 'guest library');
  raise exception 'guest inserted a library';
exception when insufficient_privilege then null;
end $$;

do $$ begin
  perform public.sync_notes('[
    {"library_id":"10000000-0000-0000-0000-000000000002","rel_path":"a.mp4","text":"x","updated_at":"2026-09-16T12:00:00.000Z"}
  ]');
  raise exception 'guest wrote state for a hidden library';
exception when insufficient_privilege then null;
end $$;

do $$ begin
  insert into public.app_owner (user_id) values ('00000000-0000-0000-0000-00000000000b');
  raise exception 'guest inserted into app_owner';
exception when insufficient_privilege then null;
end $$;

do $$ begin
  insert into public.allowed_emails (email) values ('self-promoted@example.com');
  raise exception 'guest inserted into allowed_emails';
exception when insufficient_privilege then null;
end $$;

do $$ begin
  update public.app_owner set user_id = '00000000-0000-0000-0000-00000000000b';
  if found then raise exception 'guest updated app_owner'; end if;
end $$;

do $$ begin
  insert into public.video_state (library_id, rel_path, watched, updated_at)
    values ('10000000-0000-0000-0000-000000000002', 'a.mp4', true, now());
  raise exception 'guest directly inserted video_state for a hidden library';
exception when insufficient_privilege then null;
end $$;

do $$ begin
  insert into public.notes (user_id, library_id, rel_path, text, updated_at)
    values ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', 'x.mp4', 'hi', now());
  raise exception 'guest directly inserted a note with the owner''s user_id';
exception when insufficient_privilege then null;
end $$;

do $$ begin
  update public.notes set user_id = '00000000-0000-0000-0000-00000000000a'
    where user_id = '00000000-0000-0000-0000-00000000000b' and rel_path = '01 Intro.mp4';
  if found then raise exception 'guest reassigned their own note to the owner'; end if;
exception when insufficient_privilege then null;
end $$;

-- Unconfirmed: allowlisted by email, but the address was never confirmed, so treated as a stranger.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000d","email":"unconfirmed@example.com","role":"authenticated"}';

select 'unconfirmed libraries' as check, count(*) from public.libraries;
select 'unconfirmed hosts' as check, count(*) from public.hosts;

-- Stranger: signed in, not allowlisted, sees nothing and writes nothing.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000c","email":"stranger@example.com","role":"authenticated"}';

select 'stranger libraries' as check, count(*) from public.libraries;
select 'stranger hosts' as check, count(*) from public.hosts;

do $$ begin
  insert into public.libraries (id, name) values ('10000000-0000-0000-0000-0000000000c1', 'self-promotion');
  raise exception 'stranger inserted a library';
exception when insufficient_privilege then null;
end $$;

do $$ begin
  perform public.sync_video_state('[
    {"library_id":"10000000-0000-0000-0000-000000000001","rel_path":"01 Intro.mp4","watched":true,"position":null,"duration":null,"updated_at":"2026-09-16T12:00:00.000Z"}
  ]');
  raise exception 'stranger wrote video state';
exception when insufficient_privilege then null;
end $$;

do $$ begin
  insert into public.app_owner (user_id) values ('00000000-0000-0000-0000-00000000000c');
  raise exception 'stranger inserted into app_owner';
exception when insufficient_privilege then null;
end $$;

do $$ begin
  insert into public.allowed_emails (email) values ('self-promoted-2@example.com');
  raise exception 'stranger inserted into allowed_emails';
exception when insufficient_privilege then null;
end $$;

do $$ begin
  update public.app_owner set user_id = '00000000-0000-0000-0000-00000000000c';
  if found then raise exception 'stranger updated app_owner'; end if;
end $$;

do $$ begin
  if exists (select 1 from public.allowed_emails) or exists (select 1 from public.app_owner) then
    raise exception 'allowlist tables are readable';
  end if;
end $$;

-- Anonymous callers cannot run the sync functions at all.
reset role;
set local role anon;
do $$ begin
  perform public.sync_notes('[]');
  raise exception 'anon ran sync_notes';
exception when insufficient_privilege then null;
end $$;

select 'all checks passed' as result;
rollback;
