# Video Playlist Player

A desktop app (macOS / Windows / Linux) for watching folders of videos as a playlist, while keeping track of what you've already seen. Designed for working through courses, series, or any collection of video files organized in directories.

## Features

- Open any local folder and recursively list every video in a navigable sidebar tree
- Auto-marks videos as watched when playback finishes
- Manual mark/unmark via context menu (with "Reveal in Finder/Explorer")
- Autoplay the next unwatched video in natural folder order
- Per-video notes panel
- Resume where you stopped, and a "Hide Watched" filter that hides individual videos and entire fully-watched folders
- Recent folders on the home screen; watched state, progress and notes persist across sessions

Supported formats: `mp4`, `mov`, `m4v`, `avi`, `mkv`, `wmv`, `ts`, `mpg`, `mpeg`.

## Running

```bash
cd tauri
npm install
npm run tauri dev
```

To produce a bundle (`.app`/`.dmg` on macOS, `.msi`/`.exe` on Windows):

```bash
npm run tauri build
```

Tauri does not cross-compile the webview — build the Windows binary on Windows. See [tauri/README.md](tauri/README.md) for the stack and layout.

## Shortcuts

| Action              | Shortcut         |
| ------------------- | ---------------- |
| Open folder         | `⌘O` / `Ctrl+O`  |
| Next video          | `⌘→` / `Ctrl+→`  |
| Previous video      | `⌘←` / `Ctrl+←`  |
| Seek back / forward | `←` / `→`        |
| Toggle notes        | `⌘N` / `Ctrl+N`  |
| Back to home        | `⌘⇧H` / `Ctrl+⇧H`|

## Privacy

Nothing leaves the machine — watched state, progress and notes live in the app's local storage, and the app only reads the folders you pick.
