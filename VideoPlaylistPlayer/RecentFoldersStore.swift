import Foundation
import Observation

struct RecentFolder: Codable, Identifiable, Hashable {
    let id: UUID
    var name: String
    var path: String
    var bookmarkData: Data
    var lastOpenedAt: Date

    init(
        id: UUID = UUID(),
        name: String,
        path: String,
        bookmarkData: Data,
        lastOpenedAt: Date = Date()
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.bookmarkData = bookmarkData
        self.lastOpenedAt = lastOpenedAt
    }
}

struct ResolvedRecentFolder {
    let url: URL
    let needsRefresh: Bool
}

@Observable
final class RecentFoldersStore {
    static let shared = RecentFoldersStore()
    static let perPage = 8

    private let key = "recentFolders.v1"
    private let defaults: UserDefaults
    private(set) var folders: [RecentFolder] = []

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.folders = Self.load(from: defaults, key: key)
    }

    var pageCount: Int {
        let total = folders.count
        return total <= Self.perPage ? 1 : Int(ceil(Double(total) / Double(Self.perPage)))
    }

    func page(_ index: Int) -> [RecentFolder] {
        guard !folders.isEmpty else { return [] }
        let clamped = max(0, min(index, pageCount - 1))
        let start = clamped * Self.perPage
        let end = min(start + Self.perPage, folders.count)
        return Array(folders[start..<end])
    }

    func record(url: URL) {
        let standardized = url.standardizedFileURL
        let path = standardized.path
        let bookmark = (try? standardized.bookmarkData(
            options: .withSecurityScope,
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )) ?? Data()

        if let idx = folders.firstIndex(where: { $0.path == path }) {
            var existing = folders.remove(at: idx)
            existing.lastOpenedAt = Date()
            existing.name = standardized.lastPathComponent
            if !bookmark.isEmpty {
                existing.bookmarkData = bookmark
            }
            folders.insert(existing, at: 0)
        } else {
            let entry = RecentFolder(
                name: standardized.lastPathComponent,
                path: path,
                bookmarkData: bookmark
            )
            folders.insert(entry, at: 0)
        }
        persist()
    }

    func remove(id: UUID) {
        folders.removeAll { $0.id == id }
        persist()
    }

    func resolve(_ folder: RecentFolder) -> ResolvedRecentFolder? {
        guard !folder.bookmarkData.isEmpty else { return nil }
        var isStale = false
        guard let url = try? URL(
            resolvingBookmarkData: folder.bookmarkData,
            options: [.withSecurityScope],
            relativeTo: nil,
            bookmarkDataIsStale: &isStale
        ) else { return nil }
        return ResolvedRecentFolder(url: url, needsRefresh: isStale)
    }

    func refreshBookmark(for id: UUID, using url: URL) {
        guard let idx = folders.firstIndex(where: { $0.id == id }) else { return }
        guard let bookmark = try? url.bookmarkData(
            options: .withSecurityScope,
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        ) else { return }
        folders[idx].bookmarkData = bookmark
        persist()
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(folders) else { return }
        defaults.set(data, forKey: key)
    }

    private static func load(from defaults: UserDefaults, key: String) -> [RecentFolder] {
        guard let data = defaults.data(forKey: key),
              let decoded = try? JSONDecoder().decode([RecentFolder].self, from: data) else {
            return []
        }
        return decoded.sorted { $0.lastOpenedAt > $1.lastOpenedAt }
    }
}
