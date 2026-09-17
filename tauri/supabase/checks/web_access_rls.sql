\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'owner@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'guest@example.com'),
  ('00000000-0000-0000-0000-00000000000c', 'stranger@example.com');
insert into public.app_owner (user_id) values ('00000000-0000-0000-0000-00000000000a');
insert into public.allowed_emails (email) values ('guest@example.com');

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
