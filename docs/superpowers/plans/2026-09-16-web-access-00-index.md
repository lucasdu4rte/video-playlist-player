# Web Access — Plan Index and Shared Contract

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement these plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream the owner's local library to a browser behind Supabase auth, with watched/position/notes synced between desktop and web.

**Architecture:** Five PR-sized plans, executed in order. Each plan ships working, testable software on its own. This index holds what every plan shares: global constraints and the exact names that cross plan boundaries.

**Tech Stack:** Tauri v2, Rust (axum, tower-http, jsonwebtoken, hmac), React 19 + TypeScript + Vite, Supabase (Auth + Postgres + RLS), cloudflared quick tunnels, Vercel, vitest.

**Spec:** `docs/superpowers/specs/2026-09-16-web-access-design.md`

## Plans

| # | Plan | Ships | Depends on |
|---|---|---|---|
| 1 | `2026-09-16-web-access-01-sync-foundation.md` | Timestamps, dirty set, library ids, path translation, `SEP` fix, vitest | — |
| 2 | `2026-09-16-web-access-02-supabase-desktop-auth.md` | Schema + RLS, desktop sign-in, push/pull sync, library linking | 1 |
| 3 | `2026-09-16-web-access-03-pc-server.md` | axum server: JWKS auth, `/api/tree`, `/api/sign`, `/media` | 2 |
| 4 | `2026-09-16-web-access-04-tunnel-sharing.md` | cloudflared on demand, `on_web` toggle, `hosts` heartbeat, tree snapshots | 3 |
| 5 | `2026-09-16-web-access-05-web-app.md` | Web mode, sign-in screen, offline state, Vercel deploy | 4 |

## Global Constraints

- All app work happens under `tauri/`; every command below runs from `tauri/` unless stated otherwise.
- Package manager is npm (`package-lock.json`); Node comes from `tauri/.node-version` via fnm.
- Native calls go through `src/lib/platform.ts`; components never import `@tauri-apps/*`.
- Persisted client state goes through `src/lib/store.ts`; components never touch `localStorage`.
- Tree walking stays in `src/lib/tree.ts`.
- No `console.log` left behind. `console.error` for genuine failures is the existing convention.
- The build stays warning-free: `npm run build` (runs `tsc`-free Vite build) and `cargo build` / `cargo clippy` in `src-tauri/` without new warnings. Type-check with `npx tsc -p tsconfig.app.json --noEmit`.
- A signed-out user, or a build without `VITE_SUPABASE_URL`, gets today's app: no listening socket, no outbound request, no `supabase-js` loaded.
- `rel_path` is always `/`-separated, never starts with `/`, never contains `..`.
- The Supabase `service_role` key is never used by the app or the PC server.
- PC server binds `127.0.0.1:8787` only.
- `cloudflared` pinned to `2026.9.1`; downloads verified against pinned SHA-256; never `latest`.
- Media URL TTL: 12 hours. Host heartbeat: 60 s. Host considered offline after 180 s. Sync push debounce: 30 s.
- Commits: Conventional Commits, scope `tauri` for app code (matches `git log`), `docs` for docs. English only. No `Co-Authored-By` trailer. Never push without asking.
- Comments only for non-obvious *why*; no section banners, no TODOs.

## Shared Contract

Names below are fixed. A plan that produces one must use exactly this name and signature; a plan that consumes one may rely on it.

### Plan 1 produces (TypeScript)

`src/lib/platform.ts`
```ts
export const isTauri: boolean;                 // already exists
export const SEP: "/" | "\\";                  // "\\" only when isTauri on Windows
```

`src/lib/libraryPath.ts`
```ts
/** Absolute path → "/"-separated path relative to root, or null when outside root. */
export function toRelPath(path: string, root: string, sep: string): string | null;
/** Inverse of toRelPath. */
export function fromRelPath(relPath: string, root: string, sep: string): string;
/** Synthetic path used by the web build: "/<libraryId>/<relPath>". */
export function webPath(libraryId: string, relPath: string): string;
export function parseWebPath(path: string): { libraryId: string; relPath: string } | null;
```

`src/lib/lww.ts`
```ts
export type Stamped<T> = { value: T; updatedAt: number };
/** Keys whose remote entry is strictly newer than the local one. */
export function newerKeys<T>(
  local: Record<string, number>,
  remote: Record<string, Stamped<T>>
): string[];
```

`src/lib/store.ts` (additions; existing API unchanged)
```ts
export type VideoRecord = {
  watched: boolean;
  position: number | null;
  duration: number | null;
  updatedAt: number;
};
export function videoRecord(path: string): VideoRecord;
export function applyVideoRecord(path: string, record: VideoRecord): void; // no dirty mark
export function noteRecord(path: string): Stamped<string>;
export function applyNoteRecord(path: string, record: Stamped<string>): void; // no dirty mark

export const Dirty: {
  take(): { videos: string[]; notes: string[] };        // clears the set
  restore(batch: { videos: string[]; notes: string[] }): void; // after a failed push
  isEmpty(): boolean;
};
/** Fires "dirty" whenever a local write marks a key dirty. */
export const LocalChanges: EventTarget;

// Recents
Recents.libraryIdFor(path: string): string;   // stable; survives Recents.remove
Recents.pathFor(libraryId: string): string | null;
Recents.link(path: string, libraryId: string): void;  // used by plan 2 linking
```

Every existing mutator (`Watched.setWatched`, `setProgress`, `clearProgress`, `removeAll`, `Playback.setDuration`, `Notes.setNote`, `Notes.removeAll`) stamps `Date.now()` and marks the affected keys dirty. Keys in `Dirty` and in the stamp maps are the same absolute-path strings the stores already use.

### Plan 2 produces

SQL (`supabase/migrations/*_web_access.sql`): tables `allowed_emails`, `libraries`, `video_state`, `notes`, `library_trees`, `hosts`; functions `public.is_allowed() returns boolean`, `public.sync_video_state(rows jsonb) returns void`, `public.sync_notes(rows jsonb) returns void`.

`src/lib/supabase.ts`
```ts
export const supabaseConfigured: boolean;               // !!import.meta.env.VITE_SUPABASE_URL
export function getSupabase(): Promise<SupabaseClient>; // dynamic import, memoised
export const SUPABASE_URL: string;
export const SUPABASE_KEY: string;                      // publishable key
```

`src/lib/auth.ts`
```ts
export type Account = { userId: string; email: string };
export function sendEmailCode(email: string): Promise<void>;
export function verifyEmailCode(email: string, code: string): Promise<Account>;
export function signInWithGoogle(): Promise<Account>;
export function signOut(): Promise<void>;
export function currentAccount(): Promise<Account | null>;
export function accessToken(): Promise<string | null>;
export function onAccountChange(cb: (a: Account | null) => void): () => void;
```

`src/lib/sync.ts`
```ts
export function startSync(account: Account): () => void; // returns stop()
export function flushNow(): Promise<void>;
export function upsertLibrary(libraryId: string, name: string): Promise<void>;
```

Rust (`src-tauri/src/server/`): module `server` with `pub async fn await_oauth_code(timeout: Duration) -> Result<String, String>`, exposed as Tauri command `oauth_wait_code`. Crates added: `axum`, `tower-http` (feature `fs`, `cors`), `tokio` (features `net`, `sync`, `time`, `macros`).

`platform.ts` gains `waitOAuthCode(): Promise<string>` and `openExternal(url: string): Promise<void>`.

### Plan 3 produces

Rust:
```rust
// server/paths.rs
pub fn resolve_media_path(root: &Path, rel: &str) -> Result<PathBuf, PathError>;
// server/signing.rs
pub fn sign(secret: &[u8], user: &str, library: &str, rel: &str, exp: u64) -> String; // hex
pub fn verify(secret: &[u8], user: &str, library: &str, rel: &str, exp: u64, sig: &str, now: u64) -> bool;
// server/jwt.rs
pub struct Claims { pub sub: String, pub email: String }
pub async fn verify_token(jwks: &JwksCache, token: &str) -> Result<Claims, AuthError>;
```

Tauri commands: `server_start(config: ServerConfig) -> Result<u16, String>`, `server_stop()`, `server_set_libraries(libraries: Vec<SharedLibrary>)`, where

```rust
#[serde(rename_all = "camelCase")]
pub struct ServerConfig { pub supabase_url: String, pub supabase_key: String, pub allowed_origins: Vec<String> }
#[serde(rename_all = "camelCase")]
pub struct SharedLibrary { pub id: String, pub root: String }
```

HTTP surface (all JSON):
- `GET /health` → `200 {"ok":true}`, no auth, CORS-enabled.
- `GET /api/tree/:library` → `FileNode[]` with `path` = `rel_path`. Bearer JWT.
- `POST /api/sign` body `{ "library": string, "path": string }` → `{ "url": "/media/<library>/<rel>?u=..&exp=..&sig=.." }`. Bearer JWT.
- `GET /media/:library/*rel?u&exp&sig` → file bytes with Range support.

`platform.ts` gains `startServer(libraries: { id: string; root: string }[]): Promise<void>`, `stopServer(): Promise<void>`, `setServerLibraries(libraries): Promise<void>`.

### Plan 4 produces

Tauri commands: `tunnel_status() -> TunnelStatus`, `tunnel_install() -> Result<(), String>`, `tunnel_start() -> Result<String, String>` (returns public URL), `tunnel_stop()`.

```rust
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus { pub installed: bool, pub source: Option<String> /* "path" | "bundled" */, pub download_bytes: u64 }
```

`src/lib/sharing.ts`
```ts
export function enableSharing(account: Account): Promise<string>; // returns tunnel URL
export function disableSharing(): Promise<void>;
export function isSharing(): boolean;
export function setOnWeb(libraryId: string, onWeb: boolean): Promise<void>;
export function publishTree(libraryId: string, roots: FileNode[], root: string): Promise<void>;
```

### Plan 5 produces

`platform.ts` gains `export type PlatformMode = "tauri" | "web" | "demo"; export const mode: PlatformMode;` and `resolveMediaSrc(path: string): Promise<string>` (Tauri: `convertFileSrc`; web: signed URL; demo: path). `Player.tsx` switches from `toMediaSrc` to `resolveMediaSrc` without changing its props.

## Contract Extensions Made While Planning

The plans refined the contract above in these places. Where a line here disagrees with the contract, this line wins.

- **Owner (plan 2):** a one-row `public.app_owner` table plus `public.is_owner()`. Deriving the owner from `libraries.owner_id` would let any stranger who signs up create a library and become an owner.
- **Pull cursor (plan 2):** `video_state` and `notes` gain a server-set `synced_at timestamptz`; pull filters on it, while `updated_at` still decides which write wins. Filtering on `updated_at` would skip rows written by a device whose clock runs behind.
- **Timestamps:** every `*_at` column is `timestamptz`; clients send ISO strings (`new Date(ms).toISOString()`).
- **`store.ts` (plan 2):** `AUTH_STORAGE_KEY`, `hasStoredSession()`, `SyncCursor`.
- **`syncRows.ts` (plan 2):** `MappedLibrary`, `VideoStateRow`, `NoteRow`, `RecordReaders`, `toSyncRows`, `toLocalVideos`, `toLocalNotes`; re-exports `DirtyBatch` from `store.ts`.
- **`sync.ts` (plan 2):** `RemoteLibrary`, `LinkRequest`, `RemoteChanges` (EventTarget `App.tsx` listens to after a pull), `registerOpenedLibrary`, `linkLibrary`.
- **OAuth listener (plans 2–3):** lives in `server/oauth.rs`, re-exported by `server/mod.rs`. While the sharing server runs it serves `/auth/callback` itself, and `await_oauth_code` does not bind the port. tokio also needs the `rt` feature.
- **Rust HTTP stack (plan 3):** routes use axum 0.8 syntax `/api/tree/{library}` and `/media/{library}/{*rel}`. `server_stop` returns `Result<(), String>`. `reqwest = { version = "0.13", default-features = false, features = ["json", "native-tls"] }` is shared with plan 4. `tower-http` stays on `0.6`.
- **`platform.ts` (plans 3–5):** `type SharedLibrary = { id: string; root: string }`; `type TunnelStatus = { installed: boolean; source: "path" | "bundled" | null; downloadBytes: number }`; `tunnelStatus()`, `installTunnel()`, `startTunnel()`, `stopTunnel()`. `resolveMediaSrc` replaces `toMediaSrc`. `mode === "web"` also requires Vite's `MODE === "web"`, so `npm run preview` keeps the demo tree.
- **`libraryPath.ts` (plans 4–5):** `relativizeTree(nodes, root, sep)`, `webRoot(libraryId)`, `parseWebRoot(root)`, `toWebTree(libraryId, nodes)`. A web library's root is `"/" + libraryId` with no trailing slash (`webPath(id, "")` yields a trailing slash and is not used as a root).
- **`sharing.ts` (plan 4):** `subscribeSharing`, `sharingAccount`, `onWebLibraries`, `trackAccount`; `setOnWeb(libraryId, value)`. The `on_web` state lives in this module's memory, loaded from Supabase on sign-in.
- **Web modules (plan 5):** `host.ts` (`HOST_OFFLINE_AFTER_MS`, `HostStatus`, `MediaFailure`, `MediaUnavailableError`, `isHostOnline`, `hostStatus`, `signMediaUrl`), `webLibrary.ts` (`WebLibrary`, `listWebLibraries`, `loadWebTree`), `webAuth.ts` (`signInWithGoogleRedirect`, `sendEmailLink`, `isAllowed`); components `SignInScreen`, `WebGate`, `WebHome`. `upsertLibrary` is a no-op outside Tauri.
- **Removing a folder from Recents (plan 1 → plan 2):** `Watched.removeAll` / `Notes.removeAll` stamp and mark every cleared key dirty, so the next push erases that folder's progress and notes on every device and on the web (approved during design). Plan 2 must change the remove-confirmation copy in `Home.tsx` to say the data is erased on all devices when the user is signed in. The library id itself survives removal.
- **Temporary dev hook (plan 3 → 4):** `src/lib/devServer.ts` exposes `window.devServer` in dev builds; plan 4 deletes it.
- **`store.ts` (plan 2, added during final review):** `Dirty.done()` clears the in-flight batch once a push succeeds, and `syncInFlight.v1` persists that batch across the push so a crash mid-push re-sends it on restart.
- **Pull RPCs (plan 2, added during final review):** `pull_video_state` / `pull_notes(since, after_library, after_path, max_rows)` page by keyset on `(synced_at, library_id, rel_path)` rather than offset, so concurrent writes from another device can't skip or repeat rows.
- **`sync.ts` (plan 2, amended during final review):** `registerOpenedLibrary` is `async`, returning `Promise<LinkRequest | null>` — its link-vs-new decision runs inside the sync queue, after the library list has loaded at least once this sign-in, instead of racing that first load synchronously.
- **`is_allowed()` (plan 2, added during final review):** matches `auth.users.email_confirmed_at`, never the JWT email claim, so an unconfirmed guest sign-in is never treated as allowed.
- **`Home.tsx` (plan 2, added during final review):** takes a `signedIn` prop; the folder-removal confirmation copy appends "on all your devices" when signed in, since removal erases progress and notes everywhere, not just locally.

## Known Risks Carried Into Execution

- Plans 2–5 were written in parallel against the contract, not against each other's final code. Their old→new snippets for `App.tsx`, `AppHeader.tsx`, `main.tsx`, `lib.rs` and `vite-env.d.ts` target today's files; merge by hand where an earlier plan already changed the same lines.
- Enabling the Google provider in `supabase/config.toml` may stop `supabase start` without a client id and secret; plan 2 puts placeholders in `supabase/.env.local`.
- `cargo test` for the OAuth listener binds the real port 8787 and fails while the app is running.
- A macOS app launched from Finder has a minimal `PATH`, so a Homebrew `cloudflared` is not found and the app downloads its pinned copy.
- The web library view (resizable panels) is not designed for phone widths.
