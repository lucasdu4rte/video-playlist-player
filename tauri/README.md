# Video Playlist Player — Tauri prototype

Cross-platform (macOS / Windows / Linux) port of the SwiftUI app, built to be
faithful to the native experience.

## Stack

- **Backend:** Rust (Tauri v2). It does only what the web layer can't — a
  `scan_folder` command that walks the tree (natural sort, prunes empty
  folders, video-extension filter, matching the Swift rules) and grants
  asset-protocol access so the local file can play; `path_exists` backs the
  "folder unavailable" state on the Home screen.
- **Frontend:** React + TypeScript + Vite, styled with Tailwind CSS v4 and
  shadcn/ui components (Button, Toggle, DropdownMenu, Tooltip, ScrollArea,
  ContextMenu, Dialog). Playback is a native `<video controls>` (scrubber,
  fullscreen, PiP for free) fed by `convertFileSrc`. Watched marks, resume
  progress, notes and recent folders persist in `localStorage` (the
  `UserDefaults` stand-in).

## Layout

- `src/` — React app (`App.tsx` holds state + playback logic; `components/`
  the views; `lib/` the platform bridge, store and tree helpers).
- `src-tauri/` — Rust backend and Tauri config.

Outside a Tauri window (e.g. `npm run preview` in a plain browser) the native
bridge is absent, so the app falls back to a small demo tree — handy for
iterating on the UI without rebuilding the desktop app. That branch is dead in
the shipped bundle.

## Run

```bash
cd tauri
npm install        # first time only
npm run tauri dev  # launches the native window with HMR
npm run tauri build  # produces .app/.dmg (mac) or .msi/.exe (windows)
```

To build the Windows binary, run `npm run tauri build` **on Windows** — Tauri
does not cross-compile the webview. Same source, no code changes.
