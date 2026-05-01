import SwiftUI
import AVKit
import Foundation
import AppKit

enum FileItemType {
    case folder
    case video
}

@Observable
final class FileItem: Identifiable, Hashable {
    let id = UUID()
    let url: URL
    let name: String
    let type: FileItemType
    var isExpanded: Bool = false
    var isWatched: Bool = false
    var children: [FileItem]? = nil

    init(url: URL, type: FileItemType) {
        self.url = url
        self.name = url.lastPathComponent
        self.type = type
    }

    static func == (lhs: FileItem, rhs: FileItem) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

@Observable
final class WatchedStore {
    static let shared = WatchedStore()
    private let watchedKey = "watchedPaths.v1"
    private let progressKey = "videoProgress.v1"
    private(set) var watched: Set<String>
    private(set) var progress: [String: Double]

    init() {
        let arr = UserDefaults.standard.stringArray(forKey: watchedKey) ?? []
        self.watched = Set(arr)
        let stored = UserDefaults.standard.dictionary(forKey: progressKey) as? [String: Double] ?? [:]
        self.progress = stored
    }

    func snapshot() -> Set<String> { watched }

    func contains(_ url: URL) -> Bool {
        watched.contains(url.standardizedFileURL.path)
    }

    func setWatched(_ url: URL, _ value: Bool) {
        let path = url.standardizedFileURL.path
        if value {
            watched.insert(path)
            if progress.removeValue(forKey: path) != nil {
                UserDefaults.standard.set(progress, forKey: progressKey)
            }
        } else {
            watched.remove(path)
        }
        UserDefaults.standard.set(Array(watched), forKey: watchedKey)
    }

    func progress(for url: URL) -> Double? {
        progress[url.standardizedFileURL.path]
    }

    func setProgress(_ url: URL, seconds: Double) {
        let path = url.standardizedFileURL.path
        progress[path] = seconds
        UserDefaults.standard.set(progress, forKey: progressKey)
    }

    func clearProgress(_ url: URL) {
        let path = url.standardizedFileURL.path
        guard progress.removeValue(forKey: path) != nil else { return }
        UserDefaults.standard.set(progress, forKey: progressKey)
    }
}

@Observable
final class LibraryViewModel {
    var rootItems: [FileItem] = []
    var hideWatched: Bool = false
    var autoplayNext: Bool = true
    var currentlyPlayingID: UUID? = nil
    var hasOpenedFolder: Bool = false
    var isLoading: Bool = false

    private static let videoExtensions: Set<String> = [
        "mp4", "mov", "m4v", "avi", "mkv", "wmv", "ts", "mpg", "mpeg"
    ]

    @MainActor
    func loadFolder(_ url: URL) async {
        isLoading = true
        hasOpenedFolder = true
        let watchedSnapshot = WatchedStore.shared.snapshot()
        let items = await Task.detached(priority: .userInitiated) {
            Self.buildFileTree(from: url, watched: watchedSnapshot)
        }.value
        self.rootItems = items
        isLoading = false
    }

    private static func buildFileTree(from url: URL, watched: Set<String>) -> [FileItem] {
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.isDirectoryKey, .isPackageKey]
        guard let contents = try? fm.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: keys,
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return [] }

        let sorted = contents.sorted {
            $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending
        }

        var items: [FileItem] = []
        for itemURL in sorted {
            let values = try? itemURL.resourceValues(forKeys: Set(keys))
            let isDirectory = values?.isDirectory ?? false
            let isPackage = values?.isPackage ?? false

            if isDirectory && !isPackage {
                let folder = FileItem(url: itemURL, type: .folder)
                folder.children = buildFileTree(from: itemURL, watched: watched)
                if !(folder.children?.isEmpty ?? true) {
                    items.append(folder)
                }
            } else if videoExtensions.contains(itemURL.pathExtension.lowercased()) {
                let video = FileItem(url: itemURL, type: .video)
                video.isWatched = watched.contains(itemURL.standardizedFileURL.path)
                items.append(video)
            }
        }
        return items
    }

    func markAsWatched(_ item: FileItem) {
        guard !item.isWatched else { return }
        item.isWatched = true
        WatchedStore.shared.setWatched(item.url, true)
    }

    func markAsUnwatched(_ item: FileItem) {
        guard item.isWatched else { return }
        item.isWatched = false
        WatchedStore.shared.setWatched(item.url, false)
    }

    func videosInDisplayOrder() -> [FileItem] {
        var out: [FileItem] = []
        func walk(_ items: [FileItem]) {
            for item in items {
                switch item.type {
                case .video:
                    out.append(item)
                case .folder:
                    if let children = item.children { walk(children) }
                }
            }
        }
        walk(rootItems)
        return out
    }

    func nextUnwatched(after item: FileItem) -> FileItem? {
        let videos = videosInDisplayOrder()
        guard let idx = videos.firstIndex(where: { $0.id == item.id }) else { return nil }
        if let next = videos.dropFirst(idx + 1).first(where: { !$0.isWatched }) {
            return next
        }
        return videos.dropFirst(idx + 1).first
    }

    func video(after item: FileItem) -> FileItem? {
        let videos = videosInDisplayOrder()
        guard let idx = videos.firstIndex(where: { $0.id == item.id }), idx + 1 < videos.count
        else { return nil }
        return videos[idx + 1]
    }

    func video(before item: FileItem) -> FileItem? {
        let videos = videosInDisplayOrder()
        guard let idx = videos.firstIndex(where: { $0.id == item.id }), idx > 0
        else { return nil }
        return videos[idx - 1]
    }

    func subtreeHasUnwatchedVideo(_ item: FileItem) -> Bool {
        switch item.type {
        case .video:
            return !item.isWatched
        case .folder:
            return (item.children ?? []).contains(where: subtreeHasUnwatchedVideo)
        }
    }
}

struct FileRow: View {
    @Bindable var item: FileItem
    let library: LibraryViewModel
    let onPlay: (FileItem) -> Void

    var body: some View {
        if item.type == .folder {
            DisclosureGroup(isExpanded: $item.isExpanded) {
                ForEach(filteredChildren) { child in
                    FileRow(item: child, library: library, onPlay: onPlay)
                }
            } label: {
                Label(item.name, systemImage: item.isExpanded ? "folder.fill" : "folder")
                    .foregroundStyle(.tint)
                    .lineLimit(1)
            }
        } else {
            HStack(spacing: 6) {
                Image(systemName: isCurrentlyPlaying ? "play.circle.fill" : "film")
                    .foregroundStyle(isCurrentlyPlaying ? Color.accentColor : .secondary)
                Text(item.name)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .fontWeight(isCurrentlyPlaying ? .semibold : .regular)
                Spacer(minLength: 4)
                if item.isWatched {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .accessibilityLabel("Watched")
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { onPlay(item) }
            .contextMenu {
                if item.isWatched {
                    Button("Mark as Unwatched") { library.markAsUnwatched(item) }
                } else {
                    Button("Mark as Watched") { library.markAsWatched(item) }
                }
                Divider()
                Button("Reveal in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting([item.url])
                }
            }
        }
    }

    private var isCurrentlyPlaying: Bool {
        library.currentlyPlayingID == item.id
    }

    private var filteredChildren: [FileItem] {
        let children = item.children ?? []
        guard library.hideWatched else { return children }
        return children.filter { library.subtreeHasUnwatchedVideo($0) }
    }
}

private struct PlayerView: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.player = player
        view.controlsStyle = .inline
        view.showsFullScreenToggleButton = true
        view.allowsPictureInPicturePlayback = true
        return view
    }

    func updateNSView(_ nsView: AVPlayerView, context: Context) {
        if nsView.player !== player {
            nsView.player = player
        }
    }
}

private struct FolderDropTarget: ViewModifier {
    @Binding var isTargeted: Bool
    let onDrop: ([URL]) -> Bool

    func body(content: Content) -> some View {
        content
            .dropDestination(for: URL.self) { urls, _ in
                onDrop(urls)
            } isTargeted: { isTargeted = $0 }
            .overlay {
                if isTargeted {
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(
                            Color.accentColor,
                            style: StrokeStyle(lineWidth: 2, dash: [8, 4])
                        )
                        .padding(8)
                        .allowsHitTesting(false)
                }
            }
    }
}

struct ContentView: View {
    @State private var library = LibraryViewModel()
    @State private var player: AVPlayer?
    @State private var endObserver: NSObjectProtocol?
    @State private var timeObserver: Any?
    @State private var currentVideo: FileItem?
    @State private var isSidebarDropTargeted: Bool = false
    @State private var isDetailDropTargeted: Bool = false
    @AppStorage("playbackSpeed.v1") private var playbackSpeed: Double = 1.0

    private static let speedOptions: [Double] = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]

    private static func speedLabel(_ speed: Double) -> String {
        speed.truncatingRemainder(dividingBy: 1) == 0
            ? "\(Int(speed))×"
            : String(format: "%g×", speed)
    }

    var body: some View {
        @Bindable var library = library
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 220, ideal: 300, max: 480)
        } detail: {
            detail
        }
        .navigationTitle(currentVideo?.name ?? "Video Playlist Player")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    selectFolder()
                } label: {
                    Label("Open Folder", systemImage: "folder")
                }
                .keyboardShortcut("o", modifiers: .command)
                .help("Open Folder (⌘O)")
            }
            ToolbarItem {
                Toggle(isOn: $library.hideWatched) {
                    Label("Hide Watched", systemImage: library.hideWatched ? "eye.slash.fill" : "eye.slash")
                }
                .help("Hide videos already watched")
            }
            ToolbarItem {
                Toggle(isOn: $library.autoplayNext) {
                    Label("Autoplay Next", systemImage: "forward.end")
                }
                .help("Automatically play the next unwatched video")
            }
            ToolbarItem {
                Menu {
                    Picker("Playback Speed", selection: $playbackSpeed) {
                        ForEach(Self.speedOptions, id: \.self) { speed in
                            Text(Self.speedLabel(speed)).tag(speed)
                        }
                    }
                } label: {
                    Label(Self.speedLabel(playbackSpeed), systemImage: "speedometer")
                }
                .help("Playback Speed")
            }
            ToolbarItem {
                Button {
                    playPrevious()
                } label: {
                    Label("Previous", systemImage: "backward.end")
                }
                .keyboardShortcut(.leftArrow, modifiers: .command)
                .disabled(currentVideo == nil)
                .help("Previous Video (⌘←)")
            }
            ToolbarItem {
                Button {
                    playNext()
                } label: {
                    Label("Next", systemImage: "forward.end")
                }
                .keyboardShortcut(.rightArrow, modifiers: .command)
                .disabled(currentVideo == nil)
                .help("Next Video (⌘→)")
            }
        }
        .frame(minWidth: 720, minHeight: 480)
        .onDisappear {
            persistCurrentProgress()
            removePlaybackObservers()
        }
        .onChange(of: playbackSpeed) { _, newValue in
            guard let player else { return }
            let rate = Float(newValue)
            player.defaultRate = rate
            if player.rate != 0 { player.rate = rate }
        }
    }

    @ViewBuilder
    private var sidebar: some View {
        if library.isLoading {
            ProgressView("Loading folder…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if !library.hasOpenedFolder {
            ContentUnavailableView(
                "No folder opened",
                systemImage: "folder",
                description: Text("Choose a folder from the toolbar or drag one here.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
            .modifier(FolderDropTarget(isTargeted: $isSidebarDropTargeted, onDrop: handleDrop))
        } else if filteredRoot.isEmpty {
            ContentUnavailableView(
                library.hideWatched ? "Nothing left to watch" : "No videos here",
                systemImage: "tray",
                description: Text(library.hideWatched
                                  ? "All videos in this folder are marked as watched."
                                  : "This folder contains no playable videos.")
            )
        } else {
            List {
                ForEach(filteredRoot) { item in
                    FileRow(item: item, library: library, onPlay: playVideo)
                }
            }
            .listStyle(.sidebar)
        }
    }

    @ViewBuilder
    private var detail: some View {
        if let player {
            PlayerView(player: player)
                .frame(minHeight: 400)
                .background(Color.black)
        } else if !library.hasOpenedFolder {
            ContentUnavailableView(
                "No folder opened",
                systemImage: "folder",
                description: Text("Drag a folder here or choose one from the toolbar.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
            .modifier(FolderDropTarget(isTargeted: $isDetailDropTargeted, onDrop: handleDrop))
        } else {
            ContentUnavailableView(
                "No video selected",
                systemImage: "play.rectangle",
                description: Text("Choose a video from the sidebar to start playing.")
            )
        }
    }

    private var filteredRoot: [FileItem] {
        guard library.hideWatched else { return library.rootItems }
        return library.rootItems.filter { library.subtreeHasUnwatchedVideo($0) }
    }

    private func selectFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Open"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await library.loadFolder(url) }
    }

    private func handleDrop(_ urls: [URL]) -> Bool {
        guard let folder = urls.first(where: isDirectory) else { return false }
        Task { await library.loadFolder(folder) }
        return true
    }

    private func isDirectory(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
    }

    private func playVideo(_ video: FileItem) {
        guard video.type == .video else { return }
        guard video.id != library.currentlyPlayingID else { return }

        persistCurrentProgress()
        removePlaybackObservers()
        player?.pause()

        let newPlayer = AVPlayer(url: video.url)
        player = newPlayer
        currentVideo = video
        library.currentlyPlayingID = video.id

        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: newPlayer.currentItem,
            queue: .main
        ) { _ in
            handlePlaybackEnded(of: video)
        }

        let interval = CMTime(seconds: 2, preferredTimescale: 1)
        timeObserver = newPlayer.addPeriodicTimeObserver(forInterval: interval, queue: .main) { time in
            let seconds = time.seconds
            guard seconds.isFinite, seconds > 3 else { return }
            WatchedStore.shared.setProgress(video.url, seconds: seconds)
        }

        if let saved = WatchedStore.shared.progress(for: video.url), saved > 0 {
            let target = CMTime(seconds: saved, preferredTimescale: 1000)
            newPlayer.currentItem?.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero, completionHandler: nil)
        }

        newPlayer.defaultRate = Float(playbackSpeed)
        newPlayer.play()
    }

    private func handlePlaybackEnded(of video: FileItem) {
        library.markAsWatched(video)
        if library.autoplayNext, let next = library.nextUnwatched(after: video) {
            playVideo(next)
        }
    }

    private func playNext() {
        guard let current = currentVideo, let next = library.video(after: current) else { return }
        playVideo(next)
    }

    private func playPrevious() {
        guard let current = currentVideo, let previous = library.video(before: current) else { return }
        playVideo(previous)
    }

    private func removePlaybackObservers() {
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
        endObserver = nil
        if let timeObserver {
            player?.removeTimeObserver(timeObserver)
        }
        timeObserver = nil
    }

    private func persistCurrentProgress() {
        guard let player, let video = currentVideo else { return }
        let seconds = player.currentTime().seconds
        guard seconds.isFinite, seconds > 3 else { return }
        WatchedStore.shared.setProgress(video.url, seconds: seconds)
    }
}
