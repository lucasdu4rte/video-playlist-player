# CLAUDE.md

Technical guide for working in this project. Focused on patterns, setup, and commands — not on file structure (which can change and should be inspected directly).

## Stack

- **Platform:** native macOS app (no iOS, no Catalyst)
- **UI:** pure SwiftUI; AppKit only for narrow integrations (`NSOpenPanel`, `NSWorkspace`)
- **Media:** `AVKit` / `AVPlayer` for playback; SwiftUI's `VideoPlayer` view in the detail pane
- **Persistence:** `UserDefaults` for lightweight state (watched paths). No Core Data, SwiftData, or external DB
- **Language:** Swift 5
- **Deployment target:** macOS 15.4
- **Build system:** plain Xcode project (`.xcodeproj`); no SPM/CocoaPods/Carthage
- **Unit tests:** Swift Testing (`import Testing`, `@Test`, `#expect`)
- **UI tests:** classic XCTest (`XCUIApplication`)

## Project conventions

### State management

- Use `@Observable` (Observation framework) for models. **Do not** use `ObservableObject` / `@Published` / `@StateObject` — the project is on the new Observation framework
- Models are `final class` with `@Observable`
- In views: `@State` to instantiate the model, and `@Bindable var` inside `body` to derive bindings from properties of `@Observable` classes
- Use singletons only when something genuinely needs to be a cross-view global store (e.g. a persisted-state store). Don't overuse them

### Concurrency

- Filesystem I/O must run off the main thread. The pattern is `Task.detached(priority: .userInitiated)` for the recursive scan, with the scan function being `static` or pure to avoid capturing `self`
- Methods that mutate observed state and are called from a detached task must be `@MainActor`
- Snapshot any shared state (e.g. the `Set<String>` of watched paths) **before** hopping to the background thread, and pass the immutable snapshot into the scan. Don't read shared stores from inside background work

### AVPlayer lifecycle

- Whenever you switch videos: `pause()` the previous player, **remove the `AVPlayerItemDidPlayToEndTime` observer**, build a fresh `AVPlayer(url:)`, register a new observer, and only then call `play()`
- Hold the observer as `@State` (`NSObjectProtocol`) and remove it in `onDisappear` of the root view
- "Mark as watched" happens inside the playback-ended callback, before deciding whether to advance to the next item

### Filesystem

- Use `URL` (not `String`) for paths. Normalize with `.standardizedFileURL.path` before comparing or persisting
- To list a directory: `FileManager.default.contentsOfDirectory(at:includingPropertiesForKeys:options:)` with `[.skipsHiddenFiles, .skipsPackageDescendants]`, and read `.isDirectoryKey` / `.isPackageKey` via `resourceValues(forKeys:)` — don't infer "is folder" from the extension
- Listings are sorted with `localizedStandardCompare` (Finder-style natural ordering with numbers)
- Video extensions are checked lowercased against a constant `Set<String>`

### Sandbox

- The app is sandbox-enabled with `com.apple.security.files.user-selected.read-only`. File access **only** through `NSOpenPanel` — any feature that needs to write to disk or read arbitrary paths will fail silently until the entitlement is widened
- Don't add network or hardware entitlements without a clear reason

### View composition

- `NavigationSplitView` (sidebar + detail) is the canonical layout
- Empty states use `ContentUnavailableView` — don't roll a custom one
- Toolbar shortcuts: `.keyboardShortcut(_:modifiers:)` directly on the `ToolbarItem`'s button. Pair with `.help(_:)` for the tooltip
- Folder hierarchy uses `DisclosureGroup` with `isExpanded` bound directly to the item (`@Bindable var item`)

### Filters and derivations

- Filters like "hide watched" are **computed** over `rootItems`, not destructive mutations. The model tree stays intact; the view filters at render time
- "Does this folder have any unwatched video?" is recursive over `children` — watch performance on large trees (cache only after measuring, not preemptively)

## Useful commands

### Build

```sh
# Debug build from CLI
xcodebuild -project VideoPlaylistPlayer.xcodeproj \
           -scheme VideoPlaylistPlayer \
           -configuration Debug build

# Release build
xcodebuild -project VideoPlaylistPlayer.xcodeproj \
           -scheme VideoPlaylistPlayer \
           -configuration Release build

# Clean
xcodebuild -project VideoPlaylistPlayer.xcodeproj \
           -scheme VideoPlaylistPlayer clean
```

### Tests

```sh
# Run all tests (unit + UI) on the default Mac destination
xcodebuild test -project VideoPlaylistPlayer.xcodeproj \
                -scheme VideoPlaylistPlayer \
                -destination 'platform=macOS'

# Unit tests only
xcodebuild test -project VideoPlaylistPlayer.xcodeproj \
                -scheme VideoPlaylistPlayer \
                -destination 'platform=macOS' \
                -only-testing:VideoPlaylistPlayerTests
```

### Distribution

```sh
# Archive for distribution
xcodebuild archive -project VideoPlaylistPlayer.xcodeproj \
                   -scheme VideoPlaylistPlayer \
                   -archivePath build/VideoPlaylistPlayer.xcarchive

# List available destinations (handy when debugging CI)
xcodebuild -project VideoPlaylistPlayer.xcodeproj \
           -scheme VideoPlaylistPlayer \
           -showdestinations
```

### Quick reset

```sh
# Wipe global DerivedData (fixes most "works here but won't compile" issues)
rm -rf ~/Library/Developer/Xcode/DerivedData

# Wipe local build output
rm -rf build/
```

## Conventions for new code

- Tree-walk helpers (next video, count unwatched, etc.) belong in the view-model, **not** inside the view
- Operations that mutate persisted state (mark as watched) update the observed object **and** the store in a single call — don't let the two drift out of sync
- Don't introduce external dependencies without a real need. If you do, use SPM — never CocoaPods
- No `print` for logging. If you need logs, use `Logger` (`os.log`)
- Keep the build warning-free. Fix any warning in the same PR that introduced it
