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
    private let key = "watchedPaths.v1"
    private(set) var watched: Set<String>

    init() {
        let arr = UserDefaults.standard.stringArray(forKey: key) ?? []
        self.watched = Set(arr)
    }

    func snapshot() -> Set<String> { watched }

    func contains(_ url: URL) -> Bool {
        watched.contains(url.standardizedFileURL.path)
    }

    func setWatched(_ url: URL, _ value: Bool) {
        let path = url.standardizedFileURL.path
        if value {
            watched.insert(path)
        } else {
            watched.remove(path)
        }
        UserDefaults.standard.set(Array(watched), forKey: key)
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

struct ContentView: View {
    @State private var library = LibraryViewModel()
    @State private var player: AVPlayer?
    @State private var endObserver: NSObjectProtocol?
    @State private var currentVideo: FileItem?

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
        .onDisappear { removeEndObserver() }
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
                description: Text("Choose a folder from the toolbar to begin.")
            )
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
            VideoPlayer(player: player)
                .frame(minHeight: 400)
                .background(Color.black)
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

    private func playVideo(_ video: FileItem) {
        guard video.type == .video else { return }
        guard video.id != library.currentlyPlayingID else { return }

        removeEndObserver()
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

    private func removeEndObserver() {
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
        endObserver = nil
    }
}
