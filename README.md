# Video Playlist Player

A desktop app (macOS / Windows / Linux) for watching folders of videos as a playlist, while keeping track of what you've already seen. Designed for working through courses, series, or any collection of video files organized in directories.

## Features

- Open any local folder and recursively list every video in a navigable sidebar tree, with a video count per folder
- Search the library, and collapse the sidebar when you want the video to fill the window
- Auto-marks videos as watched when playback finishes, with a green check in the tree
- Resumes where you stopped, and offers to restart or skip a video you've already seen
- "Continue watching" on the home screen picks up the last video you played
- Autoplay the next unwatched video in natural folder order, with an "up next" strip
- "Watched" filter that hides individual videos and entire fully-watched folders
- Per-video notes in a side panel, with a marker in the tree for videos that have one
- Recent folders on the home screen, with a removal flow that warns before discarding watched marks and notes
- Playback speed (0.5×–2×), picture-in-picture and fullscreen
- Drag a folder anywhere onto the window to open it
- Watched state, progress, durations and notes persist across sessions

Supported formats: `mp4`, `mov`, `m4v`.

> Folders may also contain `avi`, `mkv`, `wmv`, `ts`, `mpg` and `mpeg` files. They are listed, but no web-based player can decode them — the system webview has no demuxer for those containers. Selecting one shows a load error instead of playing.

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

Every push to `main` publishes a [release](https://github.com/lucasdu4rte/video-playlist-player/releases) with a macOS `.dmg` (universal) and a Windows `.msi`. Linux is supported but has no prebuilt artifact — build it from source with the commands above.

## Shortcuts

| Action              | Shortcut          |
| ------------------- | ----------------- |
| Open folder         | `⌘O` / `Ctrl+O`   |
| Back to home        | `⌘⇧H` / `Ctrl+⇧H` |
| Search the library  | `⌘K` / `Ctrl+K`   |
| Toggle notes        | `⌘N` / `Ctrl+N`   |
| Previous video      | `⌘←` / `Ctrl+←`   |
| Next video          | `⌘→` / `Ctrl+→`   |
| Seek ∓5s            | `←` / `→`         |

The same list is available in the app from the **?** button in the title bar.

## Privacy

Nothing leaves the machine — watched state, progress and notes live in the app's local storage, and the app only reads the folders you pick.
