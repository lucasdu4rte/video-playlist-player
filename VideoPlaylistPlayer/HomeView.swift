import SwiftUI

struct HomeView: View {
    let library: LibraryViewModel
    let onOpenFolder: () -> Void
    let onOpenRecent: (RecentFolder) -> Void
    let onDrop: ([URL]) -> Bool

    @State private var store = RecentFoldersStore.shared
    @State private var currentPage: Int = 0
    @State private var unavailableAlertFolder: RecentFolder?
    @State private var removalCandidate: RemovalCandidate?
    @State private var isDropTargeted: Bool = false

    private static let columns: [GridItem] = Array(
        repeating: GridItem(.flexible(), spacing: 16),
        count: 4
    )

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .modifier(FolderDropTarget(isTargeted: $isDropTargeted, onDrop: onDrop))
        .alert(
            "Folder is not available",
            isPresented: Binding(
                get: { unavailableAlertFolder != nil },
                set: { if !$0 { unavailableAlertFolder = nil } }
            ),
            presenting: unavailableAlertFolder
        ) { folder in
            Button("Remove from Recents", role: .destructive) {
                requestRemove(folder)
            }
            Button("Keep", role: .cancel) {}
        } message: { folder in
            Text("\u{201C}\(folder.name)\u{201D} can\u{2019}t be opened. The disk may be disconnected, the folder may have been moved or deleted, or access was revoked.")
        }
        .alert(
            "Remove from Recents?",
            isPresented: Binding(
                get: { removalCandidate != nil },
                set: { if !$0 { removalCandidate = nil } }
            ),
            presenting: removalCandidate
        ) { candidate in
            Button("Remove", role: .destructive) {
                performRemove(candidate.folder)
            }
            Button("Cancel", role: .cancel) {}
        } message: { candidate in
            Text(removalMessage(for: candidate))
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Recent Folders")
                    .font(.title)
                    .fontWeight(.semibold)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                onOpenFolder()
            } label: {
                Label("Open Folder…", systemImage: "folder.badge.plus")
            }
            .keyboardShortcut("o", modifiers: .command)
            .controlSize(.large)
        }
        .padding(.horizontal, 32)
        .padding(.vertical, 24)
    }

    private var subtitle: String {
        if store.folders.isEmpty {
            return "No folders yet — open one to get started."
        }
        let count = store.folders.count
        return count == 1 ? "1 folder" : "\(count) folders"
    }

    @ViewBuilder
    private var content: some View {
        if store.folders.isEmpty {
            emptyState
        } else {
            VStack(spacing: 0) {
                ScrollView {
                    LazyVGrid(columns: Self.columns, spacing: 16) {
                        ForEach(store.page(currentPage)) { folder in
                            RecentFolderCard(
                                folder: folder,
                                isAvailable: isAvailable(folder),
                                onOpen: { handleOpen(folder) },
                                onRemove: { requestRemove(folder) },
                                onRevealInFinder: { revealInFinder(folder) }
                            )
                        }
                    }
                    .padding(32)
                }
                if store.pageCount > 1 {
                    paginationBar
                }
            }
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No folders yet", systemImage: "folder")
        } description: {
            Text("Open a folder from the toolbar or drag one anywhere into this window.")
        } actions: {
            Button {
                onOpenFolder()
            } label: {
                Label("Open Folder…", systemImage: "folder.badge.plus")
            }
            .controlSize(.large)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var paginationBar: some View {
        HStack(spacing: 16) {
            Button {
                if currentPage > 0 { currentPage -= 1 }
            } label: {
                Label("Previous", systemImage: "chevron.left")
                    .labelStyle(.iconOnly)
            }
            .disabled(currentPage == 0)
            .help("Previous Page")

            Text("Page \(currentPage + 1) of \(store.pageCount)")
                .font(.callout)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(minWidth: 110)

            Button {
                if currentPage < store.pageCount - 1 { currentPage += 1 }
            } label: {
                Label("Next", systemImage: "chevron.right")
                    .labelStyle(.iconOnly)
            }
            .disabled(currentPage >= store.pageCount - 1)
            .help("Next Page")
        }
        .controlSize(.large)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity)
        .background(.bar)
    }

    private func handleOpen(_ folder: RecentFolder) {
        if isAvailable(folder) {
            onOpenRecent(folder)
        } else {
            unavailableAlertFolder = folder
        }
    }

    private func isAvailable(_ folder: RecentFolder) -> Bool {
        store.resolve(folder) != nil
    }

    private func revealInFinder(_ folder: RecentFolder) {
        if let resolved = store.resolve(folder) {
            NSWorkspace.shared.activateFileViewerSelecting([resolved.url])
        } else {
            unavailableAlertFolder = folder
        }
    }

    private func clampPage() {
        currentPage = max(0, min(currentPage, store.pageCount - 1))
    }

    private func requestRemove(_ folder: RecentFolder) {
        let watched = WatchedStore.shared.watchedCount(under: folder.path)
        let notes = NotesStore.shared.notesCount(under: folder.path)
        if watched == 0 && notes == 0 {
            performRemove(folder)
        } else {
            removalCandidate = RemovalCandidate(
                folder: folder,
                watchedCount: watched,
                notesCount: notes
            )
        }
    }

    private func performRemove(_ folder: RecentFolder) {
        WatchedStore.shared.removeAll(under: folder.path)
        NotesStore.shared.removeAll(under: folder.path)
        store.remove(id: folder.id)
        clampPage()
    }

    private func removalMessage(for candidate: RemovalCandidate) -> String {
        var parts: [String] = []
        if candidate.watchedCount > 0 {
            let label = candidate.watchedCount == 1 ? "watched mark" : "watched marks"
            parts.append("\(candidate.watchedCount) \(label)")
        }
        if candidate.notesCount > 0 {
            let label = candidate.notesCount == 1 ? "note" : "notes"
            parts.append("\(candidate.notesCount) \(label)")
        }
        let summary = parts.joined(separator: " and ")
        return "Removing \u{201C}\(candidate.folder.name)\u{201D} will also delete \(summary) saved for videos in this folder. This can\u{2019}t be undone."
    }
}

private struct RemovalCandidate: Identifiable {
    let folder: RecentFolder
    let watchedCount: Int
    let notesCount: Int
    var id: UUID { folder.id }
}

private struct RecentFolderCard: View {
    let folder: RecentFolder
    let isAvailable: Bool
    let onOpen: () -> Void
    let onRemove: () -> Void
    let onRevealInFinder: () -> Void

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 12) {
                ZStack(alignment: .topTrailing) {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color.accentColor.opacity(isAvailable ? 0.12 : 0.06))
                        .frame(height: 96)
                        .overlay {
                            Image(systemName: "folder.fill")
                                .font(.system(size: 44))
                                .foregroundStyle(isAvailable ? Color.accentColor : .secondary)
                        }
                    if !isAvailable {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                            .padding(8)
                            .help("This folder is not available right now")
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(folder.name)
                        .font(.headline)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(folder.path)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(relativeDate)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color(nsColor: .controlBackgroundColor))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.08))
            )
            .opacity(isAvailable ? 1.0 : 0.55)
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Open") { onOpen() }
                .disabled(!isAvailable)
            Button("Reveal in Finder") { onRevealInFinder() }
                .disabled(!isAvailable)
            Divider()
            Button("Remove from Recents", role: .destructive) { onRemove() }
        }
        .help(isAvailable ? folder.path : "Unavailable — \(folder.path)")
    }

    private var relativeDate: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: folder.lastOpenedAt, relativeTo: Date())
    }
}
