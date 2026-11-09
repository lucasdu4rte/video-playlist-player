# Web access with accounts — design

Status: approved for planning · Date: 2026-09-16

## Goal

Watch the same library from a browser, on any device, with the videos staying
on the owner's machine. Only invited people get in. Watched state, playback
position and notes are the same on desktop and web.

## Decisions that shape everything else

| Question | Decision |
|---|---|
| Where the bytes live | On the owner's PC, streamed through a Cloudflare quick tunnel |
| Who can watch | Anyone on an email allowlist, signing in with Google or an emailed code/link |
| Sync scope | Desktop and web share watched/position/notes through Supabase |
| Desktop login | Optional. Logged out, the app behaves exactly as it does today |
| Web frontend | Static build of the same `src/`, hosted on Vercel, deployed manually |

## Architecture

```
 Browser (web)                     Supabase                      Owner's PC (Tauri app)
 ─────────────                     ────────                      ──────────────────────
 static build of src/  ─ login ─▶  Auth (Google + email)
                       ─ data ──▶  Postgres + RLS   ◀── sync ──  desktop app, signed in
                       ◀─ host ──  hosts table      ◀─ publish ─ cloudflared quick tunnel
                                                                          │
                       ── /api, /media (JWT or signed URL) ───────▶  axum on 127.0.0.1:8787
```

One frontend, three runtime modes chosen in `platform.ts`: Tauri, web, demo.

## Identity of a video

Absolute paths cannot be the sync key: the web never sees them, and the same
folder has different paths on macOS and Windows.

- Every root folder opened while signed in becomes a **library**. Its id is the
  `crypto.randomUUID()` that `RecentFolder` already generates.
- The sync key is `(library_id, rel_path)`, with `rel_path` always
  `/`-separated, normalised on Windows.
- Each machine keeps its own `library_id → absolute path` map. Opening the same
  course on a second machine prompts the user to link it to an existing library.
- Removing a folder from Recents no longer discards its id; the
  `path → library_id` map outlives removal, so reopening the folder reuses
  the same library. Clearing the folder's watched marks and notes on removal
  is synced as a deletion to every device.
- `localStorage` stays keyed by absolute path. Translation to
  `(library_id, rel_path)` happens only at the sync boundary — no data
  migration, no changes to components.
- On the web, `FileNode.path` is the synthetic `/<library_id>/<rel_path>`, so
  every store and tree helper works unchanged.
- `SEP` moves from a userAgent check to the platform mode. A guest on Windows
  would otherwise get `\` while synthetic paths use `/`, silently breaking
  `watchedCount` and `removeAll`.

## Data model

| Table | Columns | Notes |
|---|---|---|
| `allowed_emails` | `email` | Gate for every read. Managed from Supabase Studio |
| `libraries` | `id, owner_id, name, on_web, last_opened_at, updated_at` | Replaces Recents in sync |
| `video_state` | `user_id, library_id, rel_path, watched, position, duration, updated_at` | Playback state, LWW per row |
| `notes` | `user_id, library_id, rel_path, text, updated_at` | Separate table so a position write cannot overwrite a note |
| `library_trees` | `library_id, tree jsonb, scanned_at` | Snapshot so the web still lists videos while the PC is off |
| `hosts` | `owner_id, url, updated_at` | Current tunnel URL, owner-writable only |

RLS: reads require the caller to be the owner or to have their email in
`allowed_emails`; the owner is always allowed without an entry. Guests read only
`libraries` (and their trees) where `on_web` is true, while the owner reads all
of their own. Writes to `video_state` and `notes` require `user_id = auth.uid()`,
so progress and notes are private per user — guests never see the owner's notes.
Writes to `libraries`, `library_trees` and `hosts` are restricted to the owner. The `service_role` key
appears nowhere in the app or the PC server.

`lastPlayed` is derived from the most recent `video_state.updated_at` rather
than stored. `speed` and `showDetails` stay device-local.

## Sync

- Local entries become `{ value, updatedAt }` plus a `dirty` key set. Existing
  values migrate in place as `updatedAt = 0`.
- **Push:** debounced ~30 s, plus on pause, video change, window close, and
  when connectivity returns. Batched upsert with
  `ON CONFLICT ... WHERE excluded.updated_at > updated_at`, so last-write-wins
  is enforced by the database, not by the client.
- **Pull:** on app start, on window focus, and on sign-in — `updated_at >`
  last pull, applied locally only when newer.
- No Realtime. Focus-driven pull covers one person on two devices; Realtime is
  a later upgrade if it proves necessary.
- Accepted limit: two simultaneous edits of the same note lose one of them, and
  `updatedAt` trusts the device clock.

## PC server

Lifecycle, so that a signed-out user has no open socket and makes no network
request:

- Not started with the app. It starts for the Google loopback callback
  (ephemeral, torn down after the callback or a 2-minute timeout) and while
  sharing is enabled.
- `supabase-js` loads through a dynamic import, so a signed-out app never
  fetches it. With no Supabase URL in the build, the account UI is absent
  rather than broken.
- Email sign-in needs no server: `verifyOtp` is a direct HTTPS call.

Surface, bound to `127.0.0.1:8787` only:

| Route | Auth |
|---|---|
| `/auth/callback` | none, loopback only |
| `/api/*` | Bearer JWT, email in allowlist, sharing enabled |
| `/media/<library>/<rel>` | valid, unexpired HMAC signature |

- **JWT** is verified against the project JWKS (`iss`, `aud`, signature), so no
  Supabase secret lives on the PC. Requires asymmetric signing keys, the
  default for new projects.
- **Media URLs** are signed by `POST /api/sign`: `?u=<user>&exp=<ts>&sig=<hmac>`,
  12-hour TTL, HMAC secret generated on and never leaving the PC. The allowlist
  is checked at signing time, not per byte range — removing someone takes
  effect when their URL expires.
- **Path traversal:** reject `..`, leading separators and inverted separators;
  then canonicalise and require the result to sit under the canonicalised
  library root, which is what stops a symlink pointing at `~/.ssh`. Only
  `VIDEO_EXTS` extensions are served. Errors never echo absolute paths.
- **Range requests** come from `tower-http`'s `ServeFile` (`Range`, `If-Range`,
  `ETag`), not hand-rolled.
- CORS allows the hosted origin plus localhost in dev.
- New Rust dependencies: `axum`, `tower-http`, `tokio`, `reqwest`,
  `jsonwebtoken`, `hmac`, `sha2`.

## Tunnel

- `cloudflared` is reused from `PATH` when present. Otherwise the app asks
  before downloading it (19 MB on macOS arm64, 55 MB on Windows) into
  `app_data_dir/bin/`.
- The version is pinned in code (currently `2026.9.1`) and the per-platform
  SHA-256 is pinned alongside it, because Cloudflare publishes neither
  checksums nor signatures. A mismatched download is deleted, never executed.
  Downloading `latest` would mean running a binary nobody reviewed.
- The app publishes the tunnel URL to `hosts` and heartbeats every 60 s. The web
  treats a host older than 3 minutes as offline; a clean shutdown deletes the
  row.
- Quick tunnels are best-effort and have no SLA. The upgrade path is a named
  tunnel on a domain, which also makes `hosts` unnecessary.
- The URL is public while it lives. Protection comes from the server rejecting
  unsigned and unauthenticated requests, not from the URL being secret.

## Desktop sign-in

- **Google:** system browser → Supabase OAuth → `http://127.0.0.1:8787/auth/callback`
  (PKCE), handled by the same axum server. The port is fixed because Supabase
  requires an exact redirect URL; if it is taken, sign-in fails with a clear
  message instead of picking another port.
- **Email:** six-digit code via `verifyOtp`, no redirect and no deep link. One
  email template carries both the clickable link (web) and `{{ .Token }}`
  (desktop).
- `tauri-plugin-deep-link` is deliberately avoided: another dependency, per-OS
  scheme registration, and the loopback reuses a server the project already has.

## Web behaviour

- Libraries and their trees come from `library_trees`, so the list, progress and
  notes work with the PC off; only playback is disabled, labelled "PC offline".
- Snapshots are published only for libraries with `on_web` enabled, so folder
  names that were never shared stay off Supabase.
- A snapshot can be stale: a deleted video stays listed until the next scan and
  play returns 404, surfaced as "no longer on disk".

## Testing

- **Rust (`cargo test`):** path resolution (`..`, leading slash, escaping
  symlink, non-video extension) and HMAC signing (valid, expired, tampered
  `rel_path`).
- **TypeScript (`vitest`, new devDependency):** LWW merge and path ↔
  `(library_id, rel_path)` translation, including the Windows `\` case.
- **Manual against local Supabase:** both sign-in flows, cross-device state,
  PC-offline browsing, and a guest not seeing the owner's notes.
- Out of scope: UI components and the player.

## Delivery

1. **Sync foundation, no network.** `updatedAt` + `dirty` in the stores,
   `library_id` from Recents, `SEP` from `platform.ts`, path translation,
   vitest. No visible change; fixes the Windows `SEP` bug.
2. **Supabase + desktop sign-in.** Migrations with RLS, both sign-in flows,
   push/pull with LWW. Two of the owner's machines now sync.
3. **PC server.** axum, JWKS verification, `/api/tree`, `/media` with Range,
   Rust tests. Verified over localhost with no tunnel — a usable stopping point.
4. **Tunnel and sharing.** `cloudflared` on demand, `on_web` toggle, `hosts`
   with heartbeat, tree snapshots.
5. **Web on Vercel.** Web mode in `platform.ts`, sign-in screen, offline state,
   manual deploy.

## Local development

`supabase/` lives under `tauri/`. `npx supabase start` brings up the stack;
auth emails land in Mailpit at `127.0.0.1:54324`, so the email flow needs no
real SMTP. `site_url` and the redirect allowlist point at the Vite dev server on
`localhost:1420`. Google sign-in locally needs an OAuth client of the owner's
with `http://127.0.0.1:54321/auth/v1/callback` as redirect, supplied through
`SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `..._SECRET`.
