# Supabase + Desktop Sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner sign in on the desktop app (Google or an emailed code) and sync watched state, playback position and notes between their machines through Supabase, with the database enforcing access rules and last-write-wins.

**Architecture:** One SQL migration creates the tables, RLS policies and two `SECURITY INVOKER` functions (`sync_video_state`, `sync_notes`). The functions carry the last-write-wins rule, because PostgREST upserts can't take a conditional `WHERE`. On the client, `supabase.ts` loads `supabase-js` through a dynamic import. `auth.ts` wraps both sign-in flows. Google sign-in uses a one-shot axum listener on `127.0.0.1:8787`, which hands the PKCE `code` back through the Tauri command `oauth_wait_code`. `sync.ts` pushes `Dirty` batches and pulls rows newer than a stored cursor. A pure module, `syncRows.ts`, does the path ↔ `(library_id, rel_path)` translation. `App.tsx` owns the account state, starts and stops sync, and re-reads the stores when `RemoteChanges` fires.

**Tech Stack:** Supabase (Postgres 17, Auth, PostgREST) via CLI 2.117, `@supabase/supabase-js` 2.116, axum 0.8.9, tokio 1.53, tower-http 0.6.11 (the copy Tauri already locks), React 19 + TypeScript, vitest (from plan 1), shadcn/ui.

**Spec:** docs/superpowers/specs/2026-09-16-web-access-design.md
**Index / shared contract:** docs/superpowers/plans/2026-09-16-web-access-00-index.md

## Global Constraints

All constraints in the index apply. Additionally:

- Plan 1 is merged: `SEP`, `libraryPath.ts`, `lww.ts`, `Dirty`, `LocalChanges`, `videoRecord`/`applyVideoRecord`, `noteRecord`/`applyNoteRecord` and `Recents.libraryIdFor`/`pathFor`/`link` exist exactly as in the index. `Dirty.restore` does **not** dispatch `"dirty"` (plan 1, Task 3).
- The local Supabase stack must be running for Tasks 1, 2 and the manual checklist: `npx supabase start` from `tauri/`. Database URL: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`.
- **Owner definition (decided here):** the owner is the single user id in a one-row `public.app_owner` table, set once from Studio or `psql`. `libraries.owner_id` can't define the owner, because any stranger who signs up could insert a library and promote themselves.
- **Pull cursor (deviation from the spec's wording):** pull filters on a server-stamped `synced_at` column, not on `updated_at`. `updated_at` is the writing device's clock. A device whose clock runs behind would write rows older than another device's cursor, and those rows would never be pulled. `updated_at` still decides last-write-wins, exactly as the spec says.
- Desktop sync is an owner feature. A guest who signs in on the desktop gets no library rows (`libraries` is read with `owner_id = me`), so nothing syncs for them. Guests use the web (plan 5).
- Only the local stack is configured here. The hosted project is set up in plan 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `tauri/supabase/migrations/20260916120000_web_access.sql` (new) | Tables, RLS, `is_owner()`, `is_allowed()`, `sync_video_state()`, `sync_notes()` |
| `tauri/supabase/checks/web_access_rls.sql` (new) | Rolled-back SQL script asserting RLS + LWW against the local DB |
| `tauri/supabase/config.toml` | Asymmetric signing keys, sign-in email template, Google provider, loopback redirect |
| `tauri/supabase/templates/sign_in.html` (new) | One email carrying both the link (web) and `{{ .Token }}` (desktop) |
| `tauri/supabase/.gitignore` | Ignores `signing_keys.json` |
| `tauri/src-tauri/Cargo.toml` | Adds `axum`, `tokio`, `tower-http` |
| `tauri/src-tauri/src/server/mod.rs` (new) | `server` module root; re-exports `await_oauth_code` (plan 3 adds siblings) |
| `tauri/src-tauri/src/server/oauth.rs` (new) | One-shot loopback listener returning the OAuth `code` |
| `tauri/src-tauri/src/lib.rs` | Registers the `oauth_wait_code` command |
| `tauri/src-tauri/tauri.conf.json` | CSP `connect-src` allows the local and hosted Supabase APIs |
| `tauri/src/lib/platform.ts` | `waitOAuthCode()`, `openExternal()` |
| `tauri/src/vite-env.d.ts` (new) | Types for `import.meta.env` |
| `tauri/.env.example` (new) | Documents `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` |
| `tauri/.gitignore` | Ignores `.env.local` |
| `tauri/package.json`, `package-lock.json` | Adds `@supabase/supabase-js` |
| `tauri/src/lib/store.ts` | `AUTH_STORAGE_KEY`, `hasStoredSession()`, `SyncCursor` |
| `tauri/src/lib/supabase.ts` (new) | Env config + memoised dynamic-import client |
| `tauri/src/lib/auth.ts` (new) | Sign-in/out flows, current account, account-change listeners |
| `tauri/src/lib/syncRows.ts` (new) | Pure translation: dirty paths → rows, rows → local records |
| `tauri/src/lib/syncRows.test.ts` (new) | vitest for the translation |
| `tauri/src/lib/sync.ts` (new) | Push/pull engine, library registry, linking, `RemoteChanges` |
| `tauri/src/components/ui/input.tsx` (new, shadcn CLI) | Text input primitive |
| `tauri/src/components/AccountMenu.tsx` (new) | Header "Sign in" button / account dropdown |
| `tauri/src/components/SignInDialog.tsx` (new) | Google button + email code form |
| `tauri/src/components/LinkLibraryDialog.tsx` (new) | "Link to an existing library or keep as new" choice |
| `tauri/src/components/AppHeader.tsx` | Renders `AccountMenu` |
| `tauri/src/App.tsx` | Account state, sync lifecycle, flush triggers, remote refresh, dialogs |
| `CLAUDE.md` | Documents the Supabase setup and sync conventions |

---

### Task 1: Schema, RLS and last-write-wins functions

**Files:**
- Create: `tauri/supabase/checks/web_access_rls.sql`
- Create: `tauri/supabase/migrations/20260916120000_web_access.sql`
- Test: `tauri/supabase/checks/web_access_rls.sql` (run with `psql`)

**Interfaces:**
- Consumes: nothing.
- Produces (SQL, all in `public`):
  - tables `app_owner(singleton, user_id)`, `allowed_emails(email)`, `libraries(id, owner_id, name, on_web, last_opened_at, updated_at)`, `library_trees(library_id, tree, scanned_at)`, `hosts(owner_id, url, updated_at)`, `video_state(user_id, library_id, rel_path, watched, position, duration, updated_at, synced_at)`, `notes(user_id, library_id, rel_path, text, updated_at, synced_at)`
  - `is_owner() returns boolean`, `is_allowed() returns boolean`
  - `sync_video_state(rows jsonb) returns void`, `sync_notes(rows jsonb) returns void`. Each element of `rows` is `{library_id, rel_path, watched, position, duration, updated_at}` or `{library_id, rel_path, text, updated_at}`; `user_id` always comes from `auth.uid()`.

- [ ] **Step 1: Write the failing check script**

Create `tauri/supabase/checks/web_access_rls.sql`. It lives outside `supabase/tests/` on purpose, because `supabase test db` would try to run it as pgTAP.
```sql
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
```

- [ ] **Step 2: Run it and watch it fail**

Run (from `tauri/`):
```sh
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/checks/web_access_rls.sql
```
Expected: stops at the first setup insert with `ERROR:  relation "public.app_owner" does not exist`.

- [ ] **Step 3: Write the migration**

Create `tauri/supabase/migrations/20260916120000_web_access.sql`:
```sql
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
  rel_path text not null check (rel_path <> '' and rel_path !~ '^/' and rel_path !~ '(^|/)\.\.(/|$)'),
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
  rel_path text not null check (rel_path <> '' and rel_path !~ '^/' and rel_path !~ '(^|/)\.\.(/|$)'),
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
    or exists (select 1 from public.allowed_emails where email = lower(auth.jwt() ->> 'email'));
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
  select auth.uid(), r.library_id, r.rel_path, r.watched, r.position, r.duration, r.updated_at
  from jsonb_to_recordset(rows) as r(
    library_id uuid, rel_path text, watched boolean,
    position double precision, duration double precision, updated_at timestamptz
  )
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
  select auth.uid(), r.library_id, r.rel_path, r.text, r.updated_at
  from jsonb_to_recordset(rows) as r(library_id uuid, rel_path text, text text, updated_at timestamptz)
  on conflict (user_id, library_id, rel_path) do update
    set text = excluded.text,
        updated_at = excluded.updated_at,
        synced_at = now()
    where excluded.updated_at > n.updated_at;
$$;

revoke execute on function public.is_owner, public.is_allowed, public.sync_video_state, public.sync_notes from public, anon;
grant execute on function public.is_owner, public.is_allowed, public.sync_video_state, public.sync_notes to authenticated;
```

- [ ] **Step 4: Apply it to the local database**

Run: `npx supabase migration up`
Expected: `Applying migration 20260916120000_web_access.sql...` followed by `Local database is up to date.`

- [ ] **Step 5: Run the check script and watch it pass**

Run: `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/checks/web_access_rls.sql`
Expected (verified against Postgres 17.6; `SET`/`DO`/`INSERT` noise elided):
```
       check       | watched | position
-------------------+---------+----------
 lww older ignored | f       |       42

     check      | watched | position |       updated_at
----------------+---------+----------+------------------------
 lww newer wins | t       |          | 2026-09-16 13:00:00+00

 owner sees libraries |     2
 guest libraries | Shared course
 guest trees |     1
 guest hosts |     1
 guest sees owner notes |     0
 guest sees owner state |     0
 guest own note | guest note
 stranger libraries |     0
 stranger hosts |     0

      result
-------------------
 all checks passed

ROLLBACK
```
Any failed assertion stops the script with `ERROR:  <message>` (for example `ERROR:  stranger inserted a library`). The script ends in `rollback`, so it leaves no rows behind.

- [ ] **Step 6: Commit**

```sh
git add supabase/migrations/20260916120000_web_access.sql supabase/checks/web_access_rls.sql
git commit -m "feat(tauri): add web access schema with RLS and last-write-wins sync"
```

---

### Task 2: Local Supabase auth configuration

**Files:**
- Modify: `tauri/supabase/config.toml`
- Modify: `tauri/supabase/.gitignore`
- Create: `tauri/supabase/templates/sign_in.html`

**Interfaces:**
- Consumes: nothing.
- Produces: an Auth server that signs JWTs with an ES256 key (JWKS at `http://127.0.0.1:54321/auth/v1/.well-known/jwks.json`, which plan 3 needs), emails a code plus a link, accepts `http://127.0.0.1:8787/auth/callback` as a redirect, and offers Google.

- [ ] **Step 1: Ignore the signing key file**

Append to `tauri/supabase/.gitignore`:
```
# Local JWT signing keys
signing_keys.json
```

- [ ] **Step 2: Point Auth at an asymmetric key and generate it**

In `tauri/supabase/config.toml`, replace
```toml
# signing_keys_path = "./signing_keys.json"
```
with
```toml
signing_keys_path = "./signing_keys.json"
```
Then run the following. The CLI reads the configured file before it appends to it, so the file has to exist first:
```sh
echo '[]' > supabase/signing_keys.json
npx supabase gen signing-key --algorithm ES256 --yes
```
Expected: `JWT signing key appended to: supabase/signing_keys.json (now contains 1 keys)`.
Run: `git status --short supabase/` — `signing_keys.json` must **not** be listed.

- [ ] **Step 3: Allow the loopback redirect**

In `tauri/supabase/config.toml`, replace
```toml
additional_redirect_urls = ["http://localhost:1420", "http://127.0.0.1:1420"]
```
with
```toml
additional_redirect_urls = ["http://localhost:1420", "http://127.0.0.1:1420", "http://127.0.0.1:8787/auth/callback"]
```

- [ ] **Step 4: One email for both code and link**

Create `tauri/supabase/templates/sign_in.html`:
```html
<h2>Sign in to Video Playlist Player</h2>
<p>Your sign-in code:</p>
<p style="font-size: 28px; font-weight: bold; letter-spacing: 4px">{{ .Token }}</p>
<p>In a browser you can also <a href="{{ .ConfirmationURL }}">sign in with this link</a>.</p>
<p>If you did not ask to sign in, ignore this email.</p>
```
In `tauri/supabase/config.toml`, replace
```toml
# Uncomment to customize email template
# [auth.email.template.invite]
# subject = "You have been invited"
# content_path = "./supabase/templates/invite.html"
```
with the block below. A first-time address gets the confirmation email instead of the magic-link one, so both templates point at the same file:
```toml
[auth.email.template.magic_link]
subject = "Your sign-in code"
content_path = "./supabase/templates/sign_in.html"

[auth.email.template.confirmation]
subject = "Your sign-in code"
content_path = "./supabase/templates/sign_in.html"
```

- [ ] **Step 5: Enable Google**

In `tauri/supabase/config.toml`, insert this block right before `# Allow Solana wallet holders to sign in`:
```toml
[auth.external.google]
enabled = true
client_id = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID)"
secret = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)"
redirect_uri = ""
url = ""
# Required for local sign in with Google.
skip_nonce_check = true
email_optional = false
```
Put the owner's Google OAuth client into `tauri/supabase/.env.local`. The CLI loads it, and `supabase/.gitignore` already ignores it. The client's authorised redirect URI in Google Cloud must be `http://127.0.0.1:54321/auth/v1/callback`.
```
SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=<client id from Google Cloud>
SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=<client secret from Google Cloud>
```
If no Google client exists yet, use any non-empty values. Email sign-in still works, and only the Google button fails.

- [ ] **Step 6: Restart and verify**

Run: `npx supabase stop && npx supabase start`
Expected: the stack starts without config errors.
Run: `curl -s http://127.0.0.1:54321/auth/v1/.well-known/jwks.json`
Expected: JSON with one key where `"kty":"EC"` and `"alg":"ES256"`.
Run: `curl -s http://127.0.0.1:54321/auth/v1/settings`
Expected: `"external"` contains `"google":true` and `"email":true`.

- [ ] **Step 7: Commit**

```sh
git add supabase/config.toml supabase/.gitignore supabase/templates/sign_in.html
git commit -m "feat(tauri): configure local supabase auth for desktop sign-in"
```

---

### Task 3: Loopback OAuth listener and platform bridge

**Files:**
- Modify: `tauri/src-tauri/Cargo.toml`
- Create: `tauri/src-tauri/src/server/mod.rs`
- Create: `tauri/src-tauri/src/server/oauth.rs`
- Modify: `tauri/src-tauri/src/lib.rs`
- Modify: `tauri/src/lib/platform.ts`
- Test: `tauri/src-tauri/src/server/oauth.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Rust `server::await_oauth_code(timeout: Duration) -> Result<String, String>` (async). It binds `127.0.0.1:8787`, answers `GET /auth/callback?code=…` with a "you can close this tab" page, and returns the code. It returns `Err` if the port is busy (the message names 8787), if the timeout expires, or if the provider sent `error`/`error_description`. The listener is closed before it returns.
  - Tauri command `oauth_wait_code() -> Result<String, String>` (120 s timeout).
  - TS `waitOAuthCode(): Promise<string>`, `openExternal(url: string): Promise<void>`.

- [ ] **Step 1: Add the crates**

In `tauri/src-tauri/Cargo.toml`, append to `[dependencies]`:
```toml
axum = "0.8"
tokio = { version = "1", features = ["net", "sync", "time", "macros", "rt"] }
tower-http = { version = "0.6", features = ["fs", "cors"] }
```
`tower-http` 0.6 reuses the copy Tauri already locks (0.6.11). This plan doesn't use it yet, but the index assigns it to this PR for plan 3. `rt` is needed by `tokio::spawn` and `#[tokio::test]`.

- [ ] **Step 2: Write the failing test**

Create `tauri/src-tauri/src/server/mod.rs`:
```rust
mod oauth;

pub use oauth::await_oauth_code;
```
Create `tauri/src-tauri/src/server/oauth.rs` with only the test for now:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    async fn get_page(path: &str) -> String {
        let mut stream = TcpStream::connect(CALLBACK_ADDR).await.unwrap();
        let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    // A single test so the phases never race each other for the fixed port.
    #[tokio::test]
    async fn callback_listener_lifecycle() {
        let waiting = tokio::spawn(await_oauth_code(Duration::from_secs(5)));
        tokio::time::sleep(Duration::from_millis(100)).await;
        let page = get_page("/auth/callback?code=abc123").await;
        assert!(page.contains("You can close this tab"));
        assert_eq!(waiting.await.unwrap(), Ok("abc123".to_string()));

        let waiting = tokio::spawn(await_oauth_code(Duration::from_secs(5)));
        tokio::time::sleep(Duration::from_millis(100)).await;
        get_page("/auth/callback?error=access_denied&error_description=User%20cancelled").await;
        assert_eq!(
            waiting.await.unwrap(),
            Err("Sign-in failed: User cancelled".to_string())
        );

        assert_eq!(
            await_oauth_code(Duration::from_millis(50)).await,
            Err("Sign-in timed out. Try again.".to_string())
        );

        let _busy = TcpListener::bind(CALLBACK_ADDR).await.unwrap();
        let error = await_oauth_code(Duration::from_secs(1)).await.unwrap_err();
        assert!(error.contains("8787"));
    }
}
```
In `tauri/src-tauri/src/lib.rs`, add `mod server;` directly above `use std::cmp::Ordering;`.

- [ ] **Step 3: Run the test and watch it fail**

Run (from `tauri/src-tauri/`): `cargo test server::oauth`
Expected: compile errors such as `cannot find value `CALLBACK_ADDR` in this scope` and `cannot find function `await_oauth_code``.

- [ ] **Step 4: Implement the listener**

Put this above the `#[cfg(test)]` block in `tauri/src-tauri/src/server/oauth.rs`:
```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Query, State};
use axum::response::Html;
use axum::routing::get;
use axum::Router;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

// Supabase only redirects to exact allowlisted URLs, so the port cannot float.
const CALLBACK_ADDR: &str = "127.0.0.1:8787";

const DONE_PAGE: &str = r#"<!doctype html>
<meta charset="utf-8">
<title>Signed in</title>
<body style="font-family: system-ui; text-align: center; padding-top: 20vh">
  <h1>You can close this tab</h1>
  <p>Return to Video Playlist Player.</p>
</body>"#;

type Outcome = Result<String, String>;
type PendingCode = Arc<Mutex<Option<oneshot::Sender<Outcome>>>>;

pub async fn await_oauth_code(timeout: Duration) -> Result<String, String> {
    let listener = TcpListener::bind(CALLBACK_ADDR).await.map_err(|_| {
        "Port 8787 is already in use. Close the program using it and try again.".to_string()
    })?;
    let (code_tx, code_rx) = oneshot::channel();
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let pending: PendingCode = Arc::new(Mutex::new(Some(code_tx)));
    let app = Router::new()
        .route("/auth/callback", get(callback))
        .with_state(pending);
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stop_rx.await;
            })
            .await;
    });

    let outcome = tokio::time::timeout(timeout, code_rx).await;
    let _ = stop_tx.send(());
    // Bounded so a client that never closes its connection cannot keep the port held.
    let _ = tokio::time::timeout(Duration::from_secs(2), server).await;

    match outcome {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("Sign-in was interrupted. Try again.".into()),
        Err(_) => Err("Sign-in timed out. Try again.".into()),
    }
}

async fn callback(
    State(pending): State<PendingCode>,
    Query(params): Query<HashMap<String, String>>,
) -> Html<&'static str> {
    let error = params.get("error_description").or(params.get("error"));
    let outcome = match (params.get("code"), error) {
        (Some(code), _) => Ok(code.clone()),
        (None, Some(error)) => Err(format!("Sign-in failed: {error}")),
        (None, None) => Err("Sign-in failed: the callback carried no code.".into()),
    };
    if let Some(sender) = pending.lock().unwrap().take() {
        let _ = sender.send(outcome);
    }
    Html(DONE_PAGE)
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `cargo test server::oauth`
Expected: `test server::oauth::tests::callback_listener_lifecycle ... ok`. If the desktop app is running, close it first, because it doesn't hold 8787 at rest but a sign-in in progress would.

- [ ] **Step 6: Expose the Tauri command**

In `tauri/src-tauri/src/lib.rs`, change
```rust
use std::path::{Path, PathBuf};
```
to
```rust
use std::path::{Path, PathBuf};
use std::time::Duration;
```
and add, just above `#[cfg_attr(mobile, tauri::mobile_entry_point)]`:
```rust
const OAUTH_TIMEOUT: Duration = Duration::from_secs(120);

#[tauri::command]
async fn oauth_wait_code() -> Result<String, String> {
    server::await_oauth_code(OAUTH_TIMEOUT).await
}
```
and change
```rust
        .invoke_handler(tauri::generate_handler![scan_folder, path_exists])
```
to
```rust
        .invoke_handler(tauri::generate_handler![scan_folder, path_exists, oauth_wait_code])
```
No capability change is needed. App commands are allowed by default, and `opener:default` already includes `allow-default-urls` (http/https).

Run: `cargo clippy --all-targets`
Expected: `Finished` with no warnings.

- [ ] **Step 7: Add the platform bridge**

In `tauri/src/lib/platform.ts`, change
```ts
import { revealItemInDir } from "@tauri-apps/plugin-opener";
```
to
```ts
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
```
and append at the end of the file:
```ts
export function waitOAuthCode(): Promise<string> {
  if (!isTauri) return Promise.reject(new Error("Google sign-in needs the desktop app."));
  return invoke<string>("oauth_wait_code");
}

export async function openExternal(url: string): Promise<void> {
  if (!isTauri) {
    window.open(url, "_blank", "noopener");
    return;
  }
  await openUrl(url);
}
```
Run (from `tauri/`): `npx tsc -p tsconfig.app.json --noEmit`
Expected: no output.

- [ ] **Step 8: Commit**

```sh
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/server/mod.rs src-tauri/src/server/oauth.rs src-tauri/src/lib.rs src/lib/platform.ts
git commit -m "feat(tauri): add loopback listener for the google sign-in callback"
```

---

### Task 4: Supabase client and auth module

**Files:**
- Modify: `tauri/package.json`, `tauri/package-lock.json`
- Create: `tauri/src/vite-env.d.ts`
- Create: `tauri/.env.example`
- Modify: `tauri/.gitignore`
- Modify: `tauri/src/lib/store.ts`
- Create: `tauri/src/lib/supabase.ts`
- Create: `tauri/src/lib/auth.ts`
- Modify: `tauri/src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: `waitOAuthCode`, `openExternal` (Task 3).
- Produces:
  - `store.ts`: `export const AUTH_STORAGE_KEY = "supabaseAuth.v1"`, `export function hasStoredSession(): boolean`, `export const SyncCursor: { get(): string | null; set(iso: string): void; clear(): void }`
  - `supabase.ts`: `supabaseConfigured`, `getSupabase()`, `SUPABASE_URL`, `SUPABASE_KEY` (index signatures)
  - `auth.ts`: `Account`, `sendEmailCode`, `verifyEmailCode`, `signInWithGoogle`, `signOut`, `currentAccount`, `accessToken`, `onAccountChange` (index signatures)

There is no unit test here: every function is a thin call into `supabase-js`. The manual checklist covers both flows, and Task 7 checks the bundle split once the module is imported.

- [ ] **Step 1: Install supabase-js and type the env**

Run: `npm install @supabase/supabase-js@^2.116.0`
Expected: `package.json` `dependencies` gains `"@supabase/supabase-js": "^2.116.0"`.

Create `tauri/src/vite-env.d.ts`:
```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}
```

Create `tauri/.env.example`:
```
# Copy to .env.local. Leave VITE_SUPABASE_URL empty to build the app without accounts.
# Local stack: API_URL and PUBLISHABLE_KEY from `npx supabase status -o env`
#   VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
```
Append to `tauri/.gitignore`:
```
.env.local
```

- [ ] **Step 2: Add session and cursor keys to the store**

Append to `tauri/src/lib/store.ts`:
```ts
export const AUTH_STORAGE_KEY = "supabaseAuth.v1";

// Lets the app know whether a session exists without loading supabase-js.
export function hasStoredSession(): boolean {
  return localStorage.getItem(AUTH_STORAGE_KEY) !== null;
}

const SYNC_CURSOR_KEY = "syncCursor.v1";

export const SyncCursor = {
  get(): string | null {
    return read<string | null>(SYNC_CURSOR_KEY, null);
  },
  set(iso: string) {
    write(SYNC_CURSOR_KEY, iso);
  },
  clear() {
    localStorage.removeItem(SYNC_CURSOR_KEY);
  },
};
```

- [ ] **Step 3: Create the lazy client**

Create `tauri/src/lib/supabase.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { AUTH_STORAGE_KEY } from "@/lib/store";

export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? "";
export const SUPABASE_KEY: string = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
export const supabaseConfigured = SUPABASE_URL !== "";

let client: Promise<SupabaseClient> | null = null;

// Dynamic import keeps supabase-js out of the main bundle: signed-out users never fetch it.
export function getSupabase(): Promise<SupabaseClient> {
  client ??= import("@supabase/supabase-js").then(({ createClient }) =>
    createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { flowType: "pkce", storageKey: AUTH_STORAGE_KEY },
    })
  );
  return client;
}
```

- [ ] **Step 4: Create the auth module**

Create `tauri/src/lib/auth.ts`:
```ts
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { getSupabase, supabaseConfigured } from "@/lib/supabase";
import { openExternal, waitOAuthCode } from "@/lib/platform";
import { SyncCursor, hasStoredSession } from "@/lib/store";

export type Account = { userId: string; email: string };

const OAUTH_REDIRECT = "http://127.0.0.1:8787/auth/callback";
const PORT_CHECK_MS = 300;

const listeners = new Set<(account: Account | null) => void>();
let announcedUserId: string | null = null;
let watching = false;

function toAccount(session: Session | null): Account | null {
  const user = session?.user;
  if (!user) return null;
  return { userId: user.id, email: user.email ?? "" };
}

function requireAccount(session: Session | null): Account {
  const account = toAccount(session);
  if (!account) throw new Error("Sign-in finished without a session.");
  return account;
}

async function client(): Promise<SupabaseClient> {
  const supabase = await getSupabase();
  if (watching) return supabase;
  watching = true;
  // Token refreshes re-announce the same user; listeners only care about who is signed in.
  supabase.auth.onAuthStateChange((_event, session) => {
    const account = toAccount(session);
    const userId = account?.userId ?? null;
    if (userId === announcedUserId) return;
    announcedUserId = userId;
    if (userId === null) SyncCursor.clear();
    for (const listener of listeners) listener(account);
  });
  return supabase;
}

async function storedSession(): Promise<Session | null> {
  if (!supabaseConfigured || !hasStoredSession()) return null;
  const supabase = await client();
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function sendEmailCode(email: string): Promise<void> {
  const supabase = await client();
  const { error } = await supabase.auth.signInWithOtp({ email });
  if (error) throw error;
}

export async function verifyEmailCode(email: string, code: string): Promise<Account> {
  const supabase = await client();
  const { data, error } = await supabase.auth.verifyOtp({ email, token: code, type: "email" });
  if (error) throw error;
  return requireAccount(data.session);
}

export async function signInWithGoogle(): Promise<Account> {
  const supabase = await client();
  const code = waitOAuthCode();
  // A busy port rejects almost immediately; surface that before sending the user to Google.
  const portError = await Promise.race([
    code.then(() => null, (error: unknown) => error),
    new Promise((resolve) => setTimeout(resolve, PORT_CHECK_MS)),
  ]);
  if (portError) throw portError;

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: OAUTH_REDIRECT, skipBrowserRedirect: true },
  });
  if (error) throw error;
  await openExternal(data.url);

  const exchanged = await supabase.auth.exchangeCodeForSession(await code);
  if (exchanged.error) throw exchanged.error;
  return requireAccount(exchanged.data.session);
}

export async function signOut(): Promise<void> {
  if (!supabaseConfigured) return;
  const supabase = await client();
  // "local" ends only this device's session; the default would sign out every device.
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) throw error;
}

export async function currentAccount(): Promise<Account | null> {
  return toAccount(await storedSession());
}

export async function accessToken(): Promise<string | null> {
  const session = await storedSession();
  return session?.access_token ?? null;
}

export function onAccountChange(cb: (account: Account | null) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
```

- [ ] **Step 5: Allow the Supabase API in the CSP**

In `tauri/src-tauri/tauri.conf.json`, change the end of the `csp` string from
```
connect-src 'self' ipc: http://ipc.localhost"
```
to
```
connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:54321 https://*.supabase.co"
```

- [ ] **Step 6: Verify types and build**

Write `tauri/.env.local` with the local values: `VITE_SUPABASE_URL=http://127.0.0.1:54321` and `VITE_SUPABASE_PUBLISHABLE_KEY=` set to `PUBLISHABLE_KEY` from `npx supabase status -o env`.
Run: `npx tsc -p tsconfig.app.json --noEmit && npm run build`
Expected: no type errors. The build's only warning is the existing >500 kB chunk warning, which predates this plan and comes from the Vidstack entry chunk. Nothing imports `auth.ts` yet, so the bundle split is checked in Task 7, Step 6.

- [ ] **Step 7: Commit**

```sh
git add package.json package-lock.json src/vite-env.d.ts .env.example .gitignore src/lib/store.ts src/lib/supabase.ts src/lib/auth.ts src-tauri/tauri.conf.json
git commit -m "feat(tauri): add lazy supabase client and desktop sign-in flows"
```

---

### Task 5: Sync row translation

**Files:**
- Create: `tauri/src/lib/syncRows.test.ts`
- Create: `tauri/src/lib/syncRows.ts`

**Interfaces:**
- Consumes: `toRelPath`, `fromRelPath` (plan 1), types `Stamped`, `VideoRecord` (plan 1).
- Produces (`src/lib/syncRows.ts`):
  ```ts
  export type MappedLibrary = { id: string; root: string };
  export type DirtyBatch = { videos: string[]; notes: string[] };
  export type VideoStateRow = { library_id: string; rel_path: string; watched: boolean; position: number | null; duration: number | null; updated_at: string };
  export type NoteRow = { library_id: string; rel_path: string; text: string; updated_at: string };
  export type RecordReaders = { video: (path: string) => VideoRecord; note: (path: string) => Stamped<string> };
  export function toSyncRows(batch: DirtyBatch, libraries: MappedLibrary[], sep: string, read: RecordReaders): { videos: VideoStateRow[]; notes: NoteRow[]; unmatched: DirtyBatch };
  export function toLocalVideos(rows: VideoStateRow[], libraries: MappedLibrary[], sep: string): Record<string, Stamped<VideoRecord>>;
  export function toLocalNotes(rows: NoteRow[], libraries: MappedLibrary[], sep: string): Record<string, Stamped<string>>;
  ```
  The module only imports types from `store.ts`, so tests never touch `localStorage` or the Tauri bridge.

- [ ] **Step 1: Write the failing test**

Create `tauri/src/lib/syncRows.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { VideoRecord } from "@/lib/store";
import { toLocalNotes, toLocalVideos, toSyncRows, type RecordReaders } from "@/lib/syncRows";

const NOON = Date.UTC(2026, 8, 16, 12);

const watchedVideo: VideoRecord = { watched: true, position: null, duration: 600, updatedAt: NOON };

const read: RecordReaders = {
  video: () => watchedVideo,
  note: () => ({ value: "remember this", updatedAt: NOON }),
};

const posixLibrary = [{ id: "lib-1", root: "/Users/me/Rust" }];
const windowsLibrary = [{ id: "lib-1", root: "C:\\Courses\\Rust" }];

describe("toSyncRows", () => {
  it("turns POSIX absolute paths into library rows", () => {
    const rows = toSyncRows(
      { videos: ["/Users/me/Rust/01 Intro/a.mp4"], notes: ["/Users/me/Rust/b.mp4"] },
      posixLibrary,
      "/",
      read
    );

    expect(rows.videos).toEqual([
      {
        library_id: "lib-1",
        rel_path: "01 Intro/a.mp4",
        watched: true,
        position: null,
        duration: 600,
        updated_at: "2026-09-16T12:00:00.000Z",
      },
    ]);
    expect(rows.notes).toEqual([
      {
        library_id: "lib-1",
        rel_path: "b.mp4",
        text: "remember this",
        updated_at: "2026-09-16T12:00:00.000Z",
      },
    ]);
    expect(rows.unmatched).toEqual({ videos: [], notes: [] });
  });

  it("uses forward slashes for Windows paths", () => {
    const rows = toSyncRows(
      { videos: ["C:\\Courses\\Rust\\01 Intro\\a.mp4"], notes: [] },
      windowsLibrary,
      "\\",
      read
    );

    expect(rows.videos.map((row) => row.rel_path)).toEqual(["01 Intro/a.mp4"]);
  });

  it("keeps paths outside every library, including prefix-sharing siblings, as unmatched", () => {
    const rows = toSyncRows(
      { videos: ["/Elsewhere/a.mp4", "/Users/me/Rust 2/a.mp4"], notes: ["/Elsewhere/b.mp4"] },
      posixLibrary,
      "/",
      read
    );

    expect(rows.videos).toEqual([]);
    expect(rows.notes).toEqual([]);
    expect(rows.unmatched).toEqual({
      videos: ["/Elsewhere/a.mp4", "/Users/me/Rust 2/a.mp4"],
      notes: ["/Elsewhere/b.mp4"],
    });
  });

  it("writes one row per library when roots are nested", () => {
    const rows = toSyncRows(
      { videos: ["/Users/me/Rust/a.mp4"], notes: [] },
      [{ id: "outer", root: "/Users/me" }, ...posixLibrary],
      "/",
      read
    );

    expect(rows.videos.map((row) => [row.library_id, row.rel_path])).toEqual([
      ["outer", "Rust/a.mp4"],
      ["lib-1", "a.mp4"],
    ]);
  });
});

describe("toLocalVideos / toLocalNotes", () => {
  it("maps rows back to absolute paths and skips libraries this machine has not linked", () => {
    const videos = toLocalVideos(
      [
        {
          library_id: "lib-1",
          rel_path: "01 Intro/a.mp4",
          watched: true,
          position: null,
          duration: 600,
          updated_at: "2026-09-16T12:00:00+00:00",
        },
        {
          library_id: "not-linked",
          rel_path: "x.mp4",
          watched: true,
          position: null,
          duration: null,
          updated_at: "2026-09-16T12:00:00+00:00",
        },
      ],
      windowsLibrary,
      "\\"
    );

    expect(videos).toEqual({
      "C:\\Courses\\Rust\\01 Intro\\a.mp4": { value: watchedVideo, updatedAt: NOON },
    });
  });

  it("keeps the newest note when nested libraries resolve to the same file", () => {
    const notes = toLocalNotes(
      [
        { library_id: "lib-1", rel_path: "a.mp4", text: "newer", updated_at: "2026-09-16T12:00:00+00:00" },
        { library_id: "outer", rel_path: "Rust/a.mp4", text: "older", updated_at: "2026-09-16T11:00:00+00:00" },
      ],
      [{ id: "outer", root: "/Users/me" }, ...posixLibrary],
      "/"
    );

    expect(notes).toEqual({ "/Users/me/Rust/a.mp4": { value: "newer", updatedAt: NOON } });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/syncRows.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/syncRows"` (or `Cannot find module`).

- [ ] **Step 3: Implement the translation**

Create `tauri/src/lib/syncRows.ts`:
```ts
import type { Stamped } from "@/lib/lww";
import type { DirtyBatch, VideoRecord } from "@/lib/store";
import { fromRelPath, toRelPath } from "@/lib/libraryPath";

export type { DirtyBatch };
export type MappedLibrary = { id: string; root: string };

export type VideoStateRow = {
  library_id: string;
  rel_path: string;
  watched: boolean;
  position: number | null;
  duration: number | null;
  updated_at: string;
};

export type NoteRow = {
  library_id: string;
  rel_path: string;
  text: string;
  updated_at: string;
};

export type RecordReaders = {
  video: (path: string) => VideoRecord;
  note: (path: string) => Stamped<string>;
};

type Place = { libraryId: string; relPath: string };

// Nested roots are separate libraries, so one file can belong to several.
function placesOf(path: string, libraries: MappedLibrary[], sep: string): Place[] {
  return libraries.flatMap((library) => {
    const relPath = toRelPath(path, library.root, sep);
    return relPath === null ? [] : [{ libraryId: library.id, relPath }];
  });
}

const iso = (ms: number) => new Date(ms).toISOString();

export function toSyncRows(
  batch: DirtyBatch,
  libraries: MappedLibrary[],
  sep: string,
  read: RecordReaders
): { videos: VideoStateRow[]; notes: NoteRow[]; unmatched: DirtyBatch } {
  const videos: VideoStateRow[] = [];
  const notes: NoteRow[] = [];
  const unmatched: DirtyBatch = { videos: [], notes: [] };

  for (const path of batch.videos) {
    const places = placesOf(path, libraries, sep);
    if (places.length === 0) unmatched.videos.push(path);
    const { watched, position, duration, updatedAt } = read.video(path);
    for (const { libraryId, relPath } of places)
      videos.push({
        library_id: libraryId,
        rel_path: relPath,
        watched,
        position,
        duration,
        updated_at: iso(updatedAt),
      });
  }

  for (const path of batch.notes) {
    const places = placesOf(path, libraries, sep);
    if (places.length === 0) unmatched.notes.push(path);
    const { value, updatedAt } = read.note(path);
    for (const { libraryId, relPath } of places)
      notes.push({ library_id: libraryId, rel_path: relPath, text: value, updated_at: iso(updatedAt) });
  }

  return { videos, notes, unmatched };
}

type SyncedRow = { library_id: string; rel_path: string; updated_at: string };

function byLocalPath<R extends SyncedRow, T>(
  rows: R[],
  libraries: MappedLibrary[],
  sep: string,
  valueOf: (row: R, updatedAt: number) => T
): Record<string, Stamped<T>> {
  const roots = new Map(libraries.map((library) => [library.id, library.root]));
  const records: Record<string, Stamped<T>> = {};
  for (const row of rows) {
    const root = roots.get(row.library_id);
    if (root === undefined) continue;
    const path = fromRelPath(row.rel_path, root, sep);
    const updatedAt = Date.parse(row.updated_at);
    if ((records[path]?.updatedAt ?? -1) >= updatedAt) continue;
    records[path] = { value: valueOf(row, updatedAt), updatedAt };
  }
  return records;
}

export function toLocalVideos(
  rows: VideoStateRow[],
  libraries: MappedLibrary[],
  sep: string
): Record<string, Stamped<VideoRecord>> {
  return byLocalPath(rows, libraries, sep, (row, updatedAt) => ({
    watched: row.watched,
    position: row.position,
    duration: row.duration,
    updatedAt,
  }));
}

export function toLocalNotes(
  rows: NoteRow[],
  libraries: MappedLibrary[],
  sep: string
): Record<string, Stamped<string>> {
  return byLocalPath(rows, libraries, sep, (row) => row.text);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/lib/syncRows.test.ts`
Expected: `Test Files  1 passed (1)`, `Tests  6 passed (6)`.
Run: `npx vitest run`
Expected: all suites pass (plan 1's included).

- [ ] **Step 5: Commit**

```sh
git add src/lib/syncRows.ts src/lib/syncRows.test.ts
git commit -m "feat(tauri): translate local paths to sync rows and back"
```

---

### Task 6: Sync engine

**Files:**
- Create: `tauri/src/lib/sync.ts`

**Interfaces:**
- Consumes: `Dirty`, `LocalChanges`, `videoRecord`, `applyVideoRecord`, `noteRecord`, `applyNoteRecord`, `Recents.libraryIdFor/pathFor/link`, `Watched`, `Notes`, `Playback`, `SyncCursor` (store); `newerKeys` (lww); `SEP` (platform); `getSupabase` (Task 4); `Account` type (Task 4); `toSyncRows`, `toLocalVideos`, `toLocalNotes` (Task 5); SQL `sync_video_state`, `sync_notes`, tables `libraries`, `video_state`, `notes` (Task 1).
- Produces (`src/lib/sync.ts`):
  ```ts
  export function startSync(account: Account): () => void;          // index
  export function flushNow(): Promise<void>;                        // index; no-op while signed out
  export function upsertLibrary(libraryId: string, name: string): Promise<void>; // index; rejects on error
  export type RemoteLibrary = { id: string; name: string };
  export type LinkRequest = { path: string; name: string; candidates: RemoteLibrary[] };
  export const RemoteChanges: EventTarget;                          // fires "change" after a pull applied anything
  export function registerOpenedLibrary(path: string, name: string): LinkRequest | null;
  export function linkLibrary(path: string, libraryId: string, name: string): Promise<void>;
  ```

Behaviour:
- **Push:** runs 30 s after the first `"dirty"` event, and also on `flushNow()` (pause, video change, sign-out), `online` and `beforeunload`. It takes `Dirty`, translates the paths against the libraries that exist remotely *and* have a local root, and calls the two RPCs. On failure the whole batch is restored. Paths with no library yet are restored too, so they upload once their library is registered.
- **Pull:** runs on start (which covers sign-in) and on window `focus`. It refreshes the owner's library list, then reads `video_state` and `notes` in pages of 1000 where `synced_at > cursor − 60 s`. Only `newerKeys` are applied. The cursor advances to the largest `synced_at` seen, and `RemoteChanges` fires if anything changed.
- **Library registration:** `registerOpenedLibrary` upserts the folder, unless the folder's id is unknown remotely while this machine still has remote libraries with no local path. In that case it returns a `LinkRequest` for the dialog instead. The first registration of a library marks its whole existing local history dirty, so values saved before sign-in upload too.
- Every network task runs through one promise queue, so pushes and pulls never interleave.

- [ ] **Step 1: Write the engine**

Create `tauri/src/lib/sync.ts`:
```ts
import type { Account } from "@/lib/auth";
import { newerKeys } from "@/lib/lww";
import { SEP } from "@/lib/platform";
import {
  Dirty,
  LocalChanges,
  Notes,
  Playback,
  Recents,
  SyncCursor,
  Watched,
  applyNoteRecord,
  applyVideoRecord,
  noteRecord,
  videoRecord,
} from "@/lib/store";
import { getSupabase } from "@/lib/supabase";
import {
  toLocalNotes,
  toLocalVideos,
  toSyncRows,
  type MappedLibrary,
  type NoteRow,
  type VideoStateRow,
} from "@/lib/syncRows";

export type RemoteLibrary = { id: string; name: string };
export type LinkRequest = { path: string; name: string; candidates: RemoteLibrary[] };

/** Fires "change" after a pull wrote remote records into the local stores. */
export const RemoteChanges = new EventTarget();

const PUSH_DELAY_MS = 30_000;
const PAGE_SIZE = 1000; // matches max_rows in supabase/config.toml
// synced_at is the server clock at transaction start, so a slow transaction can
// commit a row older than the cursor we already advanced past. Re-reading a
// minute is cheap: newerKeys drops anything already applied.
const PULL_OVERLAP_MS = 60_000;
const VIDEO_COLUMNS = "library_id, rel_path, watched, position, duration, updated_at, synced_at";
const NOTE_COLUMNS = "library_id, rel_path, text, updated_at, synced_at";

type Synced<Row> = Row & { synced_at: string };

let account: Account | null = null;
let remoteLibraries: RemoteLibrary[] = [];
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let queue: Promise<void> = Promise.resolve();

function serialized(task: () => Promise<void>): Promise<void> {
  queue = queue.then(task).catch((error: unknown) => console.error("sync failed", error));
  return queue;
}

function mappedLibraries(): MappedLibrary[] {
  return remoteLibraries.flatMap(({ id }) => {
    const root = Recents.pathFor(id);
    return root === null ? [] : [{ id, root }];
  });
}

function unmappedLibraries(): RemoteLibrary[] {
  return remoteLibraries.filter(({ id }) => Recents.pathFor(id) === null);
}

// Values saved before signing in carry no dirty mark; queue them so the first
// push uploads the library's history.
function markLibraryDirty(root: string) {
  const prefix = root + SEP;
  const under = (paths: Iterable<string>) => [...paths].filter((path) => path.startsWith(prefix));
  const videoPaths = new Set([
    ...Watched.watched,
    ...Object.keys(Watched.progress),
    ...Object.keys(Playback.durations),
  ]);
  Dirty.restore({ videos: under(videoPaths), notes: under(Notes.paths()) });
}

async function callSync(fn: "sync_video_state" | "sync_notes", rows: VideoStateRow[] | NoteRow[]) {
  const supabase = await getSupabase();
  const { error } = await supabase.rpc(fn, { rows });
  if (error) throw error;
}

async function push(): Promise<void> {
  if (!account || Dirty.isEmpty()) return;
  const batch = Dirty.take();
  const rows = toSyncRows(batch, mappedLibraries(), SEP, { video: videoRecord, note: noteRecord });
  try {
    if (rows.videos.length > 0) await callSync("sync_video_state", rows.videos);
    if (rows.notes.length > 0) await callSync("sync_notes", rows.notes);
    Dirty.restore(rows.unmatched);
  } catch (error) {
    Dirty.restore(batch);
    throw error;
  }
}

function schedulePush() {
  if (pushTimer !== null) return;
  // Counted from the first change rather than reset by each one: progress is
  // saved every 5 s while playing, which would postpone a sliding debounce forever.
  pushTimer = setTimeout(() => void flushNow(), PUSH_DELAY_MS);
}

export function flushNow(): Promise<void> {
  if (pushTimer !== null) clearTimeout(pushTimer);
  pushTimer = null;
  if (!account) return Promise.resolve();
  return serialized(push);
}

async function refreshLibraries(userId: string) {
  const supabase = await getSupabase();
  const { data, error } = await supabase.from("libraries").select("id, name").eq("owner_id", userId);
  if (error) throw error;
  remoteLibraries = data as RemoteLibrary[];
}

async function fetchSince<Row>(table: "video_state" | "notes", columns: string, since: string) {
  const supabase = await getSupabase();
  const rows: Synced<Row>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .gt("synced_at", since)
      .order("synced_at")
      .order("library_id")
      .order("rel_path")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = data as unknown as Synced<Row>[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function localStamps(paths: string[], stampOf: (path: string) => number): Record<string, number> {
  return Object.fromEntries(paths.map((path) => [path, stampOf(path)]));
}

async function pull(full = false): Promise<void> {
  if (!account) return;
  await refreshLibraries(account.userId);
  const cursor = Date.parse(SyncCursor.get() ?? "") || 0;
  const since = new Date(full ? 0 : Math.max(0, cursor - PULL_OVERLAP_MS)).toISOString();
  const [videoRows, noteRows] = await Promise.all([
    fetchSince<VideoStateRow>("video_state", VIDEO_COLUMNS, since),
    fetchSince<NoteRow>("notes", NOTE_COLUMNS, since),
  ]);

  const libraries = mappedLibraries();
  const videos = toLocalVideos(videoRows, libraries, SEP);
  const notes = toLocalNotes(noteRows, libraries, SEP);
  const videoKeys = Object.keys(videos);
  const noteKeys = Object.keys(notes);
  const newVideos = newerKeys(localStamps(videoKeys, (p) => videoRecord(p).updatedAt), videos);
  const newNotes = newerKeys(localStamps(noteKeys, (p) => noteRecord(p).updatedAt), notes);
  for (const path of newVideos) applyVideoRecord(path, videos[path].value);
  for (const path of newNotes) applyNoteRecord(path, notes[path]);

  const latest = [...videoRows, ...noteRows].reduce(
    (max, row) => Math.max(max, Date.parse(row.synced_at)),
    cursor
  );
  if (latest > cursor) SyncCursor.set(new Date(latest).toISOString());
  if (newVideos.length + newNotes.length > 0) RemoteChanges.dispatchEvent(new Event("change"));
}

// With unlinked remote libraries around, a local folder may be one of them, so
// it waits for the linking dialog instead of being registered as new.
async function registerRecents() {
  if (unmappedLibraries().length > 0) return;
  const known = new Set(remoteLibraries.map(({ id }) => id));
  for (const folder of Recents.folders) {
    const id = Recents.libraryIdFor(folder.path);
    if (!known.has(id)) await upsertLibrary(id, folder.name);
  }
}

export async function upsertLibrary(libraryId: string, name: string): Promise<void> {
  if (!account) return;
  const now = new Date().toISOString();
  const supabase = await getSupabase();
  const { error } = await supabase.from("libraries").upsert({
    id: libraryId,
    owner_id: account.userId,
    name,
    last_opened_at: now,
    updated_at: now,
  });
  if (error) throw error;
  if (remoteLibraries.some(({ id }) => id === libraryId)) return;
  remoteLibraries = [...remoteLibraries, { id: libraryId, name }];
  const root = Recents.pathFor(libraryId);
  if (root !== null) markLibraryDirty(root);
  schedulePush();
}

/** Registers a folder opened while signed in, or returns the choice the user has to make first. */
export function registerOpenedLibrary(path: string, name: string): LinkRequest | null {
  if (!account) return null;
  const id = Recents.libraryIdFor(path);
  const known = remoteLibraries.some((library) => library.id === id);
  const candidates = known ? [] : unmappedLibraries();
  if (candidates.length > 0) return { path, name, candidates };
  upsertLibrary(id, name).catch((error: unknown) => console.error("library sync failed", error));
  return null;
}

export async function linkLibrary(path: string, libraryId: string, name: string): Promise<void> {
  Recents.link(path, libraryId);
  await upsertLibrary(libraryId, name);
  markLibraryDirty(path);
  // Rows for this library were skipped by earlier pulls while it had no local path.
  await serialized(() => pull(true));
  await flushNow();
}

export function startSync(signedIn: Account): () => void {
  account = signedIn;
  const onDirty = () => schedulePush();
  const onFocus = () => void serialized(pull);
  const onFlush = () => void flushNow();

  LocalChanges.addEventListener("dirty", onDirty);
  window.addEventListener("focus", onFocus);
  window.addEventListener("online", onFlush);
  window.addEventListener("beforeunload", onFlush);
  void serialized(async () => {
    await pull();
    await registerRecents();
  });
  if (!Dirty.isEmpty()) schedulePush();

  return () => {
    LocalChanges.removeEventListener("dirty", onDirty);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("online", onFlush);
    window.removeEventListener("beforeunload", onFlush);
    if (pushTimer !== null) clearTimeout(pushTimer);
    pushTimer = null;
    account = null;
    remoteLibraries = [];
  };
}
```

- [ ] **Step 2: Type-check and run the suite**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: no output.
Run: `npx vitest run`
Expected: all suites pass. `sync.ts` has no unit test of its own: its logic is the translation (Task 5), LWW (Task 1 SQL, plan 1 `newerKeys`) and orchestration, which the manual checklist covers.

- [ ] **Step 3: Commit**

```sh
git add src/lib/sync.ts
git commit -m "feat(tauri): push and pull watched state and notes through supabase"
```

---

### Task 7: Account UI and sync lifecycle

**Files:**
- Create: `tauri/src/components/ui/input.tsx` (via shadcn CLI)
- Create: `tauri/src/components/AccountMenu.tsx`
- Create: `tauri/src/components/SignInDialog.tsx`
- Modify: `tauri/src/components/AppHeader.tsx`
- Modify: `tauri/src/App.tsx`

**Interfaces:**
- Consumes: `supabaseConfigured` (Task 4); `Account`, `currentAccount`, `onAccountChange`, `sendEmailCode`, `verifyEmailCode`, `signInWithGoogle`, `signOut` (Task 4); `startSync`, `flushNow`, `RemoteChanges` (Task 6).
- Produces:
  - `AccountMenu({ account, onSignIn }: { account: Account | null; onSignIn: () => void })`. It renders nothing when `!supabaseConfigured`.
  - `SignInDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void })`
  - `AppHeader` gains props `account: Account | null`, `onSignIn: () => void`.

- [ ] **Step 1: Add the shadcn input**

Run: `npx shadcn@latest add input`
Expected: `Created 1 file: src/components/ui/input.tsx`.
Then run: `grep -n 'import { cn }' src/components/ui/input.tsx && git diff --stat package.json`
Expected: `import { cn } from "@/lib/utils"` and **no** change to `package.json`. In a scratch run, the CLI wrote `from "cn"` and installed an unrelated `cn` package. If that happens, change the import to `import { cn } from "@/lib/utils"` and run `npm uninstall cn`.

- [ ] **Step 2: Create the account menu**

Create `tauri/src/components/AccountMenu.tsx`:
```tsx
import { CircleUserRound, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut, type Account } from "@/lib/auth";
import { supabaseConfigured } from "@/lib/supabase";
import { flushNow } from "@/lib/sync";

type Props = {
  account: Account | null;
  onSignIn: () => void;
};

async function signOutAfterPush() {
  await flushNow();
  try {
    await signOut();
  } catch (error) {
    console.error("sign out failed", error);
  }
}

export function AccountMenu({ account, onSignIn }: Props) {
  if (!supabaseConfigured) return null;

  if (!account)
    return (
      <Button variant="ghost" size="sm" onClick={onSignIn} className="text-muted-foreground">
        <LogIn className="size-4" />
        Sign in
      </Button>
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account" className="text-muted-foreground">
          <CircleUserRound className="size-[18px]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="font-normal text-muted-foreground">
          {account.email}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOutAfterPush()}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 3: Create the sign-in dialog**

Create `tauri/src/components/SignInDialog.tsx`:
```tsx
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { sendEmailCode, signInWithGoogle, verifyEmailCode } from "@/lib/auth";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function SignInDialog({ open, onOpenChange }: Props) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    onOpenChange(false);
    setCodeSentTo(null);
    setCode("");
    setError(null);
  };

  const run = async (task: () => Promise<unknown>, onSuccess: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await task();
      onSuccess();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const requestCode = (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    void run(() => sendEmailCode(address), () => setCodeSentTo(address));
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    if (codeSentTo === null) return;
    void run(() => verifyEmailCode(codeSentTo, code.trim()), close);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Sign in</DialogTitle>
          <DialogDescription>
            Keep watched videos, progress and notes in sync across your devices.
          </DialogDescription>
        </DialogHeader>

        <Button variant="outline" disabled={busy} onClick={() => void run(signInWithGoogle, close)}>
          Continue with Google
        </Button>

        {codeSentTo === null ? (
          <form className="flex flex-col gap-2" onSubmit={requestCode}>
            <Input
              type="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button type="submit" disabled={busy}>
              Email me a code
            </Button>
          </form>
        ) : (
          <form className="flex flex-col gap-2" onSubmit={submitCode}>
            <p className="text-sm text-muted-foreground">
              Enter the code sent to {codeSentTo}.
            </p>
            <Input
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]+"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Button type="submit" disabled={busy}>
              Verify
            </Button>
            <Button type="button" variant="ghost" onClick={() => setCodeSentTo(null)}>
              Use a different email
            </Button>
          </form>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Put the menu in the header**

In `tauri/src/components/AppHeader.tsx`:

Change
```tsx
} from "@/components/ui/tooltip";
```
to
```tsx
} from "@/components/ui/tooltip";
import { AccountMenu } from "@/components/AccountMenu";
import type { Account } from "@/lib/auth";
```
Change
```tsx
  onShowShortcuts: () => void;
};
```
to
```tsx
  onShowShortcuts: () => void;
  account: Account | null;
  onSignIn: () => void;
};
```
Change
```tsx
export function AppHeader({ canGoBack, onHome, onShowShortcuts }: Props) {
```
to
```tsx
export function AppHeader({
  canGoBack,
  onHome,
  onShowShortcuts,
  account,
  onSignIn,
}: Props) {
```
Change
```tsx
      <div className="ml-auto flex items-center gap-1">
```
to
```tsx
      <div className="ml-auto flex items-center gap-1">
        <AccountMenu account={account} onSignIn={onSignIn} />
```

- [ ] **Step 5: Wire account state, sync lifecycle and flush triggers into `App.tsx`**

In `tauri/src/App.tsx`:

Change
```tsx
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
```
to
```tsx
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import { SignInDialog } from "@/components/SignInDialog";
import { currentAccount, onAccountChange, type Account } from "@/lib/auth";
import { RemoteChanges, flushNow, startSync } from "@/lib/sync";
```
Change
```tsx
  const [, bumpRecents] = useState(0);
```
to
```tsx
  const [, bumpRecents] = useState(0);
  const [account, setAccount] = useState<Account | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [remoteRevision, setRemoteRevision] = useState(0);
```
Push when the video changes. In `playVideo`, change
```tsx
      persistProgress();
      currentTimeRef.current = 0;
      lastSavedRef.current = 0;
```
to
```tsx
      persistProgress();
      void flushNow();
      currentTimeRef.current = 0;
      lastSavedRef.current = 0;
```
Push on pause. Change
```tsx
    if (playing) void acquireWake();
    else void releaseWake();
```
to
```tsx
    if (playing) {
      void acquireWake();
      return;
    }
    void releaseWake();
    void flushNow();
```
Insert, directly above the `  // ---- derived` line:
```tsx
  useEffect(() => {
    // Token refreshes hand back a new object for the same user; keep the old
    // one so the sync effect below does not restart.
    const adopt = (next: Account | null) =>
      setAccount((prev) => (prev?.userId === next?.userId ? prev : next));
    currentAccount()
      .then(adopt)
      .catch((e) => console.error("session restore failed", e));
    return onAccountChange(adopt);
  }, []);

  useEffect(() => {
    if (!account) return;
    return startSync(account);
  }, [account]);

  useEffect(() => {
    const refresh = () => {
      setWatchedState(new Set(Watched.watched));
      setNoted(new Set(Notes.paths()));
      setRemoteRevision((n) => n + 1);
    };
    RemoteChanges.addEventListener("change", refresh);
    return () => RemoteChanges.removeEventListener("change", refresh);
  }, []);

```
Change
```tsx
      <AppHeader canGoBack={hasOpenedFolder} onHome={goHome} onShowShortcuts={() => setShowShortcuts(true)} />
```
to
```tsx
      <AppHeader
        canGoBack={hasOpenedFolder}
        onHome={goHome}
        onShowShortcuts={() => setShowShortcuts(true)}
        account={account}
        onSignIn={() => setSigningIn(true)}
      />
```
Remount the notes panel after a pull, because it keeps the note text in local state. Change
```tsx
                <NotesPanel
                  video={currentVideo}
```
to
```tsx
                <NotesPanel
                  key={remoteRevision}
                  video={currentVideo}
```
Change
```tsx
      <ShortcutsDialog open={showShortcuts} onOpenChange={setShowShortcuts} />
```
to
```tsx
      <ShortcutsDialog open={showShortcuts} onOpenChange={setShowShortcuts} />
      <SignInDialog open={signingIn} onOpenChange={setSigningIn} />
```
`remoteRevision` also re-renders `Home`, which reads the stores on every render, so recents and "continue watching" pick up pulled state without further wiring.

- [ ] **Step 6: Verify**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: no output.
Run:
```sh
npm run build
grep -c GoTrueClient "dist/$(grep -o 'assets/index-[^"]*\.js' dist/index.html)"
grep -l GoTrueClient dist/assets/*.js
```
Expected: the first `grep` prints `0`, because the entry chunk has no supabase-js. The second prints exactly one other `dist/assets/index-*.js`, which is the lazy chunk. This split was verified in a scratch build: 788 kB entry, 228 kB lazy chunk.

- [ ] **Step 7: Commit**

```sh
git add src/components/ui/input.tsx src/components/AccountMenu.tsx src/components/SignInDialog.tsx src/components/AppHeader.tsx src/App.tsx
git commit -m "feat(tauri): add account menu, sign-in dialog and background sync"
```

---

### Task 8: Library linking dialog

**Files:**
- Create: `tauri/src/components/LinkLibraryDialog.tsx`
- Modify: `tauri/src/App.tsx`

**Interfaces:**
- Consumes: `registerOpenedLibrary`, `linkLibrary`, `upsertLibrary`, `LinkRequest` (Task 6); `Recents.libraryIdFor` (plan 1).
- Produces: `LinkLibraryDialog({ request, onClose }: { request: LinkRequest | null; onClose: () => void })`.

- [ ] **Step 1: Create the dialog**

Create `tauri/src/components/LinkLibraryDialog.tsx`:
```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Recents } from "@/lib/store";
import { linkLibrary, upsertLibrary, type LinkRequest } from "@/lib/sync";

type Props = {
  request: LinkRequest | null;
  onClose: () => void;
};

export function LinkLibraryDialog({ request, onClose }: Props) {
  const [busy, setBusy] = useState(false);

  const choose = async (libraryId: string | null) => {
    if (!request) return;
    setBusy(true);
    try {
      if (libraryId) await linkLibrary(request.path, libraryId, request.name);
      else await upsertLibrary(Recents.libraryIdFor(request.path), request.name);
    } catch (error) {
      console.error("library sync failed", error);
    } finally {
      setBusy(false);
      onClose();
    }
  };

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Already syncing this folder?</DialogTitle>
          <DialogDescription>
            If “{request?.name}” is a library you opened on another device, link it to share
            its progress and notes.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {request?.candidates.map((library) => (
            <Button
              key={library.id}
              variant="outline"
              className="justify-start"
              disabled={busy}
              onClick={() => void choose(library.id)}
            >
              {library.name}
            </Button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="secondary" disabled={busy} onClick={() => void choose(null)}>
            Keep as a new library
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```
Dismissing the dialog (Esc or clicking outside) registers nothing, so the question comes back the next time the folder is opened.

- [ ] **Step 2: Ask on folder open**

In `tauri/src/App.tsx`:

Change
```tsx
import { SignInDialog } from "@/components/SignInDialog";
```
to
```tsx
import { SignInDialog } from "@/components/SignInDialog";
import { LinkLibraryDialog } from "@/components/LinkLibraryDialog";
```
Change
```tsx
import { RemoteChanges, flushNow, startSync } from "@/lib/sync";
```
to
```tsx
import {
  RemoteChanges,
  flushNow,
  registerOpenedLibrary,
  startSync,
  type LinkRequest,
} from "@/lib/sync";
```
Change
```tsx
  const [signingIn, setSigningIn] = useState(false);
```
to
```tsx
  const [signingIn, setSigningIn] = useState(false);
  const [linkRequest, setLinkRequest] = useState<LinkRequest | null>(null);
```
In `openFolder`, change
```tsx
      Recents.record(path, name);
      bumpRecents((v) => v + 1);
```
to
```tsx
      Recents.record(path, name);
      setLinkRequest(registerOpenedLibrary(path, name));
      bumpRecents((v) => v + 1);
```
(`registerOpenedLibrary` returns `null` and does nothing while signed out, so `openFolder`'s dependencies don't change.)

Change
```tsx
      <SignInDialog open={signingIn} onOpenChange={setSigningIn} />
```
to
```tsx
      <SignInDialog open={signingIn} onOpenChange={setSigningIn} />
      <LinkLibraryDialog request={linkRequest} onClose={() => setLinkRequest(null)} />
```

- [ ] **Step 3: Verify**

Run: `npx tsc -p tsconfig.app.json --noEmit && npx vitest run && npm run build`
Expected: no type errors, all tests pass, and the build succeeds with only the existing chunk-size warning.
Run (from `src-tauri/`): `cargo clippy --all-targets`
Expected: no warnings.

- [ ] **Step 4: Commit**

```sh
git add src/components/LinkLibraryDialog.tsx src/App.tsx
git commit -m "feat(tauri): offer to link a folder to a library from another device"
```

---

### Task 9: Document the setup and verify end to end

**Files:**
- Modify: `CLAUDE.md` (repo root of the worktree)

**Interfaces:**
- Consumes: everything above.
- Produces: documentation only.

- [ ] **Step 1: Update `CLAUDE.md`**

Replace the line
```
- **Persistence:** `localStorage` through the stores in `src/lib/store.ts`. No DB, no Tauri store plugin
```
with
```
- **Persistence:** `localStorage` through the stores in `src/lib/store.ts`, the source of truth on each device. No Tauri store plugin
- **Sync (optional):** Supabase (Auth + Postgres + RLS) under `tauri/supabase/`. Signed out, or built without `VITE_SUPABASE_URL`, the app never loads `supabase-js` and makes no network request
```
Insert this section directly above `## Useful commands`:
```
### Sync

- Sync keys are `(library_id, rel_path)`; translation to and from absolute paths lives in `src/lib/syncRows.ts` and happens only in `src/lib/sync.ts`
- Last-write-wins is enforced in SQL (`sync_video_state`, `sync_notes`), never in the client. Writes go through those RPCs, not table upserts
- Pull uses the server-stamped `synced_at` as its cursor; `updated_at` (device clock) only orders writes
- The owner is the single row in `public.app_owner`; guests are rows in `public.allowed_emails`. Both are edited from Studio (`http://127.0.0.1:54323`) or `psql`
- `supabase-js` is imported only through `getSupabase()` in `src/lib/supabase.ts`
```
Append to the command block under `## Useful commands`:
```
npx supabase start                    # local Supabase (API :54321, DB :54322, Studio :54323, Mailpit :54324)
npx supabase migration up             # apply new migrations to the local DB
npx vitest run                        # unit tests
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/checks/web_access_rls.sql  # RLS + LWW checks
```

- [ ] **Step 2: Commit**

```sh
git add ../CLAUDE.md
git commit -m "docs: describe supabase sync setup and conventions"
```

- [ ] **Step 3: Manual verification**

Preconditions: `npx supabase start` is running, `tauri/.env.local` holds the local URL and publishable key, and `npm run tauri dev` is running. Open DevTools with right-click → Inspect.

Signed out:
- [ ] With DevTools → Network open and the app reloaded: no request goes to `127.0.0.1:54321` and no second `index-*.js` chunk loads.
- [ ] `lsof -nP -iTCP:8787 -sTCP:LISTEN` prints nothing.
- [ ] Stop the app, rename `.env.local` to `.env.local.off`, and run `npm run tauri dev`: the header shows no "Sign in" button and the app behaves as before. Rename it back.

Email sign-in (owner):
- [ ] Click **Sign in**, enter `owner@example.com`, and click **Email me a code**. The dialog asks for the code.
- [ ] Open Mailpit at `http://127.0.0.1:54324`. The email has a six-digit code and a "sign in with this link" link.
- [ ] Enter the code and click **Verify**. The dialog closes and the header shows the account icon, whose menu lists `owner@example.com`.
- [ ] Make this user the owner (once per database):
  ```sh
  psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "insert into public.app_owner (user_id) select id from auth.users where email = 'owner@example.com'"
  ```
  Expected: `INSERT 0 1`. Before this step, the console shows `library sync failed` with an RLS error, and that is expected.
- [ ] Reload the app (Cmd+R). It is still signed in and no sign-in dialog appears.
- [ ] Open a course folder (device A). Mark a video watched, play another for about 10 s and pause it, then add a note to it.
- [ ] Within a second of the pause, Studio (`http://127.0.0.1:54323` → Table editor) shows a `libraries` row with the folder name and `on_web = false`. `video_state` shows the watched row and the position row, and `notes` shows the note. Every `rel_path` is `/`-separated and relative.
- [ ] Earlier history uploads. Watched marks made *before* signing in, in a folder that is in Recents, also appear in `video_state` after the first push (within 30 s).

Second device (same machine, second localStorage profile):
- [ ] Copy the course so device B sees a different absolute path: `cp -R "<course>" /tmp/course-on-b`.
- [ ] In the DevTools console of the running app, save profile A and start clean:
  ```js
  sessionStorage.setItem("profileA", JSON.stringify({ ...localStorage })); localStorage.clear(); location.reload();
  ```
- [ ] The app starts empty and signed out. Sign in again as `owner@example.com` with a new code from Mailpit.
- [ ] Open `/tmp/course-on-b`. The **Already syncing this folder?** dialog lists the course name. Click it: the watched mark, the resume position (play that video: it resumes at about 10 s) and the note from device A appear.
- [ ] On B, mark another video watched and edit the note, then pause or switch videos to push.
- [ ] Switch back to profile A (this also restores A's session):
  ```js
  const a = JSON.parse(sessionStorage.getItem("profileA")); localStorage.clear(); Object.entries(a).forEach(([k, v]) => localStorage.setItem(k, v)); location.reload();
  ```
  After the reload, A shows B's watched mark and B's note text. Start-up pull covers this case. To check focus pull, edit on B, swap back to A without reloading, then click another app and back.
- [ ] Last-write-wins. On A, edit the same note again. Swap to B and reload: B shows A's latest text.
- [ ] The database enforces it. In Studio, set that `notes` row's `updated_at` to one day in the future. Edit the note on B and switch videos to push: the row's `text` in Studio does **not** change. Click another app and back to B: the focus pull replaces B's edit with the remote text.
- [ ] Keep as new. On B, open a different folder the remote doesn't know. When the dialog appears, click **Keep as a new library**: a new `libraries` row appears and the dialog doesn't come back on reopen.
- [ ] Removing a folder from Recents on A (with watched marks) resets those rows remotely (`watched = false`, `position` null) after the next push, and reopening the folder keeps the same `library_id` (no new `libraries` row).

Google sign-in (needs the real client in `supabase/.env.local`):
- [ ] Sign out from the account menu. The session key `supabaseAuth.v1` disappears from localStorage, and the other profile stays signed in (its `auth.sessions` row still exists in Studio).
- [ ] Click **Continue with Google**. The system browser opens Google, and after consent the tab shows "You can close this tab". The app is signed in as the Google address.
- [ ] `lsof -nP -iTCP:8787 -sTCP:LISTEN` prints nothing a few seconds after sign-in.
- [ ] Port busy: run `python3 -m http.server 8787 --bind 127.0.0.1` in a terminal and click **Continue with Google**. The dialog shows "Port 8787 is already in use…" and no browser opens. Stop the server.
- [ ] Timeout: click **Continue with Google** and close the browser tab without signing in. After 2 minutes the dialog shows "Sign-in timed out. Try again." and port 8787 is free.
- [ ] Cancel: click **Continue with Google** and press "Cancel" on Google's consent screen. The dialog shows "Sign-in failed: …".

Privacy:
- [ ] Add a guest: `insert into public.allowed_emails (email) values ('guest@example.com')`. Sign in on a clean profile as `guest@example.com` and open any folder. No `libraries` row is created (console: `library sync failed`), and Studio's `notes` shows no guest access to the owner's rows. The SQL check in Task 1 asserts the same thing at the policy level.

---

## Self-Review

### Spec coverage

| Spec requirement | Task |
|---|---|
| Tables `allowed_emails`, `libraries`, `video_state`, `notes`, `library_trees`, `hosts` | 1 |
| RLS: owner always allowed without an allowlist entry | 1 (`is_owner()` inside `is_allowed()`; check "owner sees libraries") |
| Guests read only `on_web` libraries and their trees | 1 (policies + checks "guest libraries/trees") |
| `video_state`/`notes` private per user, `user_id = auth.uid()` | 1 (policies, functions force `auth.uid()`; checks "guest sees owner …") |
| `libraries`/`library_trees`/`hosts` owner-writable only | 1 (policies; checks for guest/stranger inserts and updates) |
| LWW enforced in DB via `ON CONFLICT … WHERE excluded.updated_at > updated_at` | 1 (`sync_video_state`, `sync_notes`; checks "lww …") |
| `service_role` never used | 4 (only the publishable key is read) |
| `updated_at` as timestamptz from epoch ms | 5 (`toISOString()`), 6 |
| Push: `Dirty.take` → translate → RPC → `Dirty.restore` on failure | 5, 6 |
| Push debounced ~30 s, plus pause, video change, window close, reconnect | 6 (`schedulePush`, `online`, `beforeunload`), 7 (pause, `playVideo`) |
| Pull on start, focus and sign-in; apply only newer; notify App | 6 (`pull`, `newerKeys`, `RemoteChanges`), 7 (listener) |
| Last-pull timestamp stored via `store.ts` | 4 (`SyncCursor`), 6 |
| No Realtime | 6 (focus pull only) |
| Library id = `RecentFolder` id; linking prompt on a second machine | 6 (`registerOpenedLibrary`, `linkLibrary`), 8 |
| `path → library_id` survives removal from Recents | 6 (translation uses `Recents.pathFor`, plan 1) |
| `upsertLibrary` when a folder is recorded while signed in | 6, 8 (`openFolder`) |
| Google via system browser → loopback `127.0.0.1:8787/auth/callback` with PKCE | 3, 4 |
| Fixed port; clear error when busy; 2-minute timeout; listener torn down | 3 (Rust test covers all three) |
| Email six-digit code via `verifyOtp`, no redirect | 4, 7 |
| One email template with the link and `{{ .Token }}` | 2 |
| Asymmetric signing keys (JWKS for plan 3) | 2 |
| Redirect allowlist includes the loopback URL | 2 |
| Google provider locally with env client id/secret, `skip_nonce_check` | 2 |
| `supabase-js` via dynamic import; account UI absent without a URL | 4 (bundle check), 7 (`AccountMenu`) |
| Signed-out app opens no socket and makes no request | 3 (listener only during sign-in), 4 (`hasStoredSession` guard), 9 checklist |
| CSP allows the Supabase API | 4 |
| `.env.example` with `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` | 4 |
| vitest: path ↔ `(library_id, rel_path)` including Windows `\` | 5 |
| Manual: both sign-in flows, cross-device state, guest can't see owner's notes | 9 |
| `lastPlayed` derived from `video_state` | Not here: the desktop keeps its local `Playback.last`, and plan 5 derives it for the web |
| `speed`, `showDetails` stay device-local | Unchanged (not synced) |

### Contract check

Produced exactly as the index names them: tables `allowed_emails`, `libraries`, `video_state`, `notes`, `library_trees`, `hosts`; `public.is_allowed()`, `public.sync_video_state(rows jsonb)`, `public.sync_notes(rows jsonb)`; `supabaseConfigured`, `getSupabase()`, `SUPABASE_URL`, `SUPABASE_KEY`; `Account`, `sendEmailCode`, `verifyEmailCode`, `signInWithGoogle`, `signOut`, `currentAccount`, `accessToken`, `onAccountChange`; `startSync`, `flushNow`, `upsertLibrary`; Rust module `server` with `pub async fn await_oauth_code(timeout: Duration) -> Result<String, String>`, command `oauth_wait_code`; crates `axum`, `tower-http` (`fs`, `cors`), `tokio` (`net`, `sync`, `time`, `macros`); `platform.ts` `waitOAuthCode()`, `openExternal(url)`.

Consumed from plan 1 with the index signatures: `SEP`, `toRelPath`, `fromRelPath`, `Stamped`, `newerKeys`, `VideoRecord`, `videoRecord`, `applyVideoRecord`, `noteRecord`, `applyNoteRecord`, `Dirty.take/restore/isEmpty`, `LocalChanges`, `Recents.libraryIdFor/pathFor/link`.

Extensions (additive, named here for later plans):
- SQL: table `public.app_owner`, function `public.is_owner()`, columns `video_state.synced_at` and `notes.synced_at`.
- `store.ts`: `AUTH_STORAGE_KEY`, `hasStoredSession()`, `SyncCursor`.
- `syncRows.ts` (new module): `MappedLibrary`, `DirtyBatch`, `VideoStateRow`, `NoteRow`, `RecordReaders`, `toSyncRows`, `toLocalVideos`, `toLocalNotes`.
- `sync.ts`: `RemoteLibrary`, `LinkRequest`, `RemoteChanges`, `registerOpenedLibrary`, `linkLibrary`.
- Rust: `server/oauth.rs` holds the implementation. `tokio` also enables `rt`.
