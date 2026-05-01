//
//  VideoPlaylistPlayerTests.swift
//  VideoPlaylistPlayerTests
//
//  Created by Lucas Duarte on 10/05/25.
//

import Foundation
import Testing
@testable import VideoPlaylistPlayer

struct NotesStoreTests {

    private func makeStore() -> (NotesStore, UserDefaults, String) {
        let suite = "NotesStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let key = "notes.test"
        defaults.removePersistentDomain(forName: suite)
        return (NotesStore(defaults: defaults, key: key), defaults, key)
    }

    @Test func returnsEmptyStringForUnknownVideo() {
        let (store, _, _) = makeStore()
        let url = URL(fileURLWithPath: "/tmp/sample.mp4")
        #expect(store.note(for: url) == "")
    }

    @Test func roundTripsNoteThroughDefaults() {
        let (store, defaults, key) = makeStore()
        let url = URL(fileURLWithPath: "/tmp/sample.mp4")

        store.setNote("first lesson", for: url)
        #expect(store.note(for: url) == "first lesson")

        let reloaded = NotesStore(defaults: defaults, key: key)
        #expect(reloaded.note(for: url) == "first lesson")
    }

    @Test func emptyTextRemovesEntry() {
        let (store, _, _) = makeStore()
        let url = URL(fileURLWithPath: "/tmp/sample.mp4")

        store.setNote("temp", for: url)
        store.setNote("", for: url)

        #expect(store.note(for: url) == "")
        #expect(store.notes[url.standardizedFileURL.path] == nil)
    }

    @Test func standardizesPathsAcrossLookups() {
        let (store, _, _) = makeStore()
        let messy = URL(fileURLWithPath: "/tmp/./folder/../sample.mp4")
        let clean = URL(fileURLWithPath: "/tmp/sample.mp4")

        store.setNote("hello", for: messy)
        #expect(store.note(for: clean) == "hello")
    }

    @Test func notesAreScopedPerVideo() {
        let (store, _, _) = makeStore()
        let a = URL(fileURLWithPath: "/tmp/a.mp4")
        let b = URL(fileURLWithPath: "/tmp/b.mp4")

        store.setNote("note A", for: a)
        store.setNote("note B", for: b)

        #expect(store.note(for: a) == "note A")
        #expect(store.note(for: b) == "note B")
    }
}
