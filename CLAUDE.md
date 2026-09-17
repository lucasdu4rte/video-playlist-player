# CLAUDE.md

Technical guide for working in this project. Focused on patterns, setup, and commands — not on file structure (which can change and should be inspected directly).

## Stack

- **Platform:** desktop app via Tauri v2 (macOS / Windows / Linux). Everything lives under `tauri/`
- **Backend:** Rust, only for what the web layer can't do — `scan_folder` (recursive walk, natural sort, prunes empty folders, video-extension filter) and `path_exists`
- **Frontend:** React 19 + TypeScript + Vite, Tailwind CSS v4, shadcn/ui components
- **Media:** Vidstack (`@vidstack/react`) with its default video layout, fed by `convertFileSrc`. The layout ships its own aligned chrome — resist re-skinning it by hand, which is what the previous Video.js setup cost us
- **Persistence:** `localStorage` through the stores in `src/lib/store.ts`, the source of truth on each device. No Tauri store plugin
- **Sync (optional):** Supabase (Auth + Postgres + RLS) under `tauri/supabase/`. Signed out, or built without `VITE_SUPABASE_URL`, the app never loads `supabase-js` and makes no network request
- **Package manager:** npm (there is a `package-lock.json`; don't switch)
- **Node version:** pinned in `tauri/.node-version` (fnm picks it up on `cd`)

## Project conventions

### State

- App state is plain React `useState` in `App.tsx`, which owns the tree, playback and filter state and passes callbacks down. No Redux/Zustand/Context store
- Persisted state goes through the singletons in `src/lib/store.ts` (`Watched`, `Notes`, `Recents`). They own the `localStorage` keys and the read/write JSON guard — never touch `localStorage` directly from a component
- Mutating persisted state updates the store **and** the React state in the same handler; don't let the two drift
- Keyboard handling is one `window` `keydown` listener registered once, reading the latest callbacks from a ref — don't re-register per render, and keep bailing out early when the event target is an input/textarea/contenteditable

### Paths and the platform bridge

- Every native call goes through `src/lib/platform.ts`. Components import from there, never from `@tauri-apps/*` directly
- That module degrades to a demo tree when `isTauri` is false (a plain browser), so the UI can be iterated without rebuilding the desktop app. Keep new bridge functions following the same shape
- Paths are opaque strings from Rust: backslash-separated on Windows, forward-slash elsewhere. Decide the separator once from the platform (as `store.ts` does) — never sniff it per path
- Video extensions are checked lowercased against the `VIDEO_EXTS` constant in `src-tauri/src/lib.rs`. Adding a format means touching that list

### Tree helpers

- Tree walking (next video, next unwatched, "does this folder have unwatched", hide-watched filtering) belongs in `src/lib/tree.ts`, not in components
- Filters like "hide watched" are **computed** over the scanned roots, not destructive mutations — the tree stays intact and the view filters at render time

### UI

- shadcn/ui components live in `src/components/ui/`. Add new ones with the shadcn CLI rather than hand-rolling; the config is in `components.json`
- Tailwind v4: the theme lives in `src/index.css` (`@theme`), there is no `tailwind.config.js`
- Imports use the `@/` alias for `src/`

### Player

- The control chrome comes from Vidstack's `DefaultVideoLayout`. Style it through Vidstack's own CSS variables rather than overriding its internals; the only hand-written player CSS left is the `.player-flash` badge in `index.css`, which is ours
- `@vidstack/react`'s npm `latest` tag still points at the abandoned 0.6.15 (React 18 only). The current line ships under `next`, so keep the explicit `^1.15.6` in `package.json` — a bare `npm install @vidstack/react` installs the old one
- `Player.tsx` keeps a stable prop API (`onEnded`, `onProgress`, `onDuration`, `onPlayingChange`, `onSpeedChange`, plus a `seekBy` handle) so the player can be swapped without touching `App.tsx`

### Tauri config

- Window, CSP and bundle settings are in `src-tauri/tauri.conf.json`. The asset protocol is enabled so local files can play — widening its scope or the CSP needs a real reason
- Rust permissions live in `src-tauri/capabilities/`

### Sync

- Sync keys are `(library_id, rel_path)`; translation to and from absolute paths lives in `src/lib/syncRows.ts` and happens only in `src/lib/sync.ts`
- Last-write-wins is enforced in SQL (`sync_video_state`, `sync_notes`), never in the client. Writes go through those RPCs, not table upserts
- Pull uses the server-stamped `synced_at` as its cursor; `updated_at` (device clock) only orders writes
- The owner is the single row in `public.app_owner`; guests are rows in `public.allowed_emails`. Both are edited from Studio (`http://127.0.0.1:54323`) or `psql`
- `supabase-js` is imported only through `getSupabase()` in `src/lib/supabase.ts`
- Guest access requires a confirmed email: `[auth.email] enable_confirmations = true` and `is_allowed()` matches `auth.users.email_confirmed_at`, never the JWT email claim
- Pulls page by keyset through `pull_video_state` / `pull_notes`; in-flight push batches persist in `syncInFlight.v1` so a crash mid-push re-sends them

## Useful commands

All commands run from `tauri/`.

```sh
npm install          # first time only
npm run tauri dev    # native window with HMR
npm run tauri build  # .app/.dmg (macOS) or .msi/.exe (Windows)
npm run build        # Vite build only (no native bundle)
npm run preview      # serve the built frontend in a browser (demo-tree mode)
npx supabase start                    # local Supabase (API :54321, DB :54322, Studio :54323, Mailpit :54324)
npx supabase migration up             # apply new migrations to the local DB
npx vitest run                        # unit tests
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/checks/web_access_rls.sql  # RLS + LWW checks
```

Tauri does not cross-compile the webview: the Windows binary must be built on Windows, from the same source.

## Conventions for new code

- Don't introduce dependencies without a real need
- No `console.log` left behind
- Keep the build warning-free — TypeScript and `cargo` warnings get fixed in the PR that introduced them
