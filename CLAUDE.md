# CLAUDE.md

Technical guide for working in this project. Focused on patterns, setup, and commands — not on file structure (which can change and should be inspected directly).

## Stack

- **Platform:** desktop app via Tauri v2 (macOS / Windows / Linux). Everything lives under `tauri/`
- **Backend:** Rust, only for what the web layer can't do — `scan_folder` (recursive walk, natural sort, prunes empty folders, video-extension filter) and `path_exists`
- **Frontend:** React 19 + TypeScript + Vite, Tailwind CSS v4, shadcn/ui components
- **Media:** Video.js player fed by `convertFileSrc`; the skin is hand-written in `src/player-theme.css`
- **Persistence:** `localStorage` through the stores in `src/lib/store.ts`. No DB, no Tauri store plugin
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

### Tauri config

- Window, CSP and bundle settings are in `src-tauri/tauri.conf.json`. The asset protocol is enabled so local files can play — widening its scope or the CSP needs a real reason
- Rust permissions live in `src-tauri/capabilities/`

## Useful commands

All commands run from `tauri/`.

```sh
npm install          # first time only
npm run tauri dev    # native window with HMR
npm run tauri build  # .app/.dmg (macOS) or .msi/.exe (Windows)
npm run build        # Vite build only (no native bundle)
npm run preview      # serve the built frontend in a browser (demo-tree mode)
```

Tauri does not cross-compile the webview: the Windows binary must be built on Windows, from the same source.

## Conventions for new code

- Don't introduce dependencies without a real need
- No `console.log` left behind
- Keep the build warning-free — TypeScript and `cargo` warnings get fixed in the PR that introduced them
