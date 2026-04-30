# Video Playlist Player

A native macOS app for watching folders of videos as a playlist, while keeping track of what you've already seen. Designed for working through courses, series, or any collection of video files organized in directories.

## Features

- Open any local folder and recursively list every video in a navigable sidebar tree
- Native playback via `AVKit`
- Auto-marks videos as watched when playback finishes
- Manual mark/unmark via context menu (with "Reveal in Finder")
- Autoplay the next unwatched video in natural folder order
- Navigate between videos via toolbar or shortcuts (`⌘←` / `⌘→`)
- "Hide Watched" filter that hides individual videos and entire fully-watched folders
- Watched state persists across sessions

Supported formats: `mp4`, `mov`, `m4v`, `avi`, `mkv`, `wmv`, `ts`, `mpg`, `mpeg`.

## Requirements

- macOS 15.4 or newer
- Xcode 16+ (Swift 5)

## Running

From Xcode:

```sh
open VideoPlaylistPlayer.xcodeproj
```

Pick the `VideoPlaylistPlayer` scheme and run with `⌘R`.

From the command line:

```sh
xcodebuild -project VideoPlaylistPlayer.xcodeproj \
           -scheme VideoPlaylistPlayer \
           -configuration Debug build
```

## Usage

1. Click **Open Folder** in the toolbar (or `⌘O`) and pick the root directory
2. Expand folders in the sidebar and click any video to start playing
3. Use the toolbar toggles for **Hide Watched** and **Autoplay Next**
4. Right-click a video to mark/unmark it manually

## Shortcuts

| Action          | Shortcut |
| --------------- | -------- |
| Open folder     | `⌘O`     |
| Next video      | `⌘→`     |
| Previous video  | `⌘←`     |

## Privacy

The app runs sandboxed with read-only access to the folder you pick. Nothing leaves the machine — watched state lives in local `UserDefaults`.
