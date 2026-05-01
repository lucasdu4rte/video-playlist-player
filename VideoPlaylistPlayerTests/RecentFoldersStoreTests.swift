import Testing
import Foundation
@testable import VideoPlaylistPlayer

@Suite("RecentFoldersStore")
struct RecentFoldersStoreTests {

    private func makeStore() -> (RecentFoldersStore, UserDefaults) {
        let suiteName = "test.recent.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return (RecentFoldersStore(defaults: defaults), defaults)
    }

    private func tmpFolder(_ name: String = "folder-\(UUID().uuidString)") -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @Test("pageCount handles every boundary")
    func pageCountBoundaries() {
        let (store, _) = makeStore()
        #expect(store.pageCount == 1)

        for count in [1, 8] {
            let (s, _) = makeStore()
            for _ in 0..<count { s.record(url: tmpFolder()) }
            #expect(s.pageCount == 1, "expected 1 page for \(count) folders")
        }

        let (s9, _) = makeStore()
        for _ in 0..<9 { s9.record(url: tmpFolder()) }
        #expect(s9.pageCount == 2)

        let (s16, _) = makeStore()
        for _ in 0..<16 { s16.record(url: tmpFolder()) }
        #expect(s16.pageCount == 2)

        let (s17, _) = makeStore()
        for _ in 0..<17 { s17.record(url: tmpFolder()) }
        #expect(s17.pageCount == 3)
    }

    @Test("page slices the list correctly")
    func pageSlices() {
        let (store, _) = makeStore()
        for _ in 0..<17 { store.record(url: tmpFolder()) }
        #expect(store.page(0).count == 8)
        #expect(store.page(1).count == 8)
        #expect(store.page(2).count == 1)
        #expect(store.page(99).count == 1, "out-of-range index clamps to last page")
    }

    @Test("recording the same url is idempotent and moves to top")
    func recordIdempotent() {
        let (store, _) = makeStore()
        let a = tmpFolder("a")
        let b = tmpFolder("b")
        store.record(url: a)
        store.record(url: b)
        #expect(store.folders.count == 2)
        #expect(store.folders.first?.path == b.standardizedFileURL.path)

        store.record(url: a)
        #expect(store.folders.count == 2, "re-recording must not duplicate")
        #expect(store.folders.first?.path == a.standardizedFileURL.path, "re-recorded folder moves to top")
    }

    @Test("remove drops the entry")
    func removeEntry() {
        let (store, _) = makeStore()
        store.record(url: tmpFolder("x"))
        store.record(url: tmpFolder("y"))
        let target = store.folders[0]
        store.remove(id: target.id)
        #expect(store.folders.count == 1)
        #expect(!store.folders.contains(where: { $0.id == target.id }))
    }

    @Test("UserDefaults round-trip across instances")
    func roundTrip() {
        let suiteName = "test.roundtrip.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)

        let writer = RecentFoldersStore(defaults: defaults)
        writer.record(url: tmpFolder("alpha"))
        writer.record(url: tmpFolder("beta"))
        let writtenPaths = writer.folders.map(\.path)

        let reader = RecentFoldersStore(defaults: defaults)
        #expect(reader.folders.map(\.path) == writtenPaths)
    }
}
