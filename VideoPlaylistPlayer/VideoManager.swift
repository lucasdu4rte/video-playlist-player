import Foundation
import SwiftUI

class VideoManager: ObservableObject {
    @Published var videos: [VideoItem] = []
    
    private let saveKey = "watchedVideos"
    private let saveFileName = "videoStatus.json"
    
    private var saveFileURL: URL {
        let documentsDirectory = Foundation.FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return documentsDirectory.appendingPathComponent(saveFileName)
    }

    func load(from folderURL: URL) {
        let fileManager = Foundation.FileManager.default
        let videoExtensions = ["mp4", "mov", "m4v"]

        do {
            let urls = try fileManager.contentsOfDirectory(at: folderURL, includingPropertiesForKeys: nil)
                .filter { videoExtensions.contains($0.pathExtension.lowercased()) }

            let savedStatuses = loadStatuses()

            self.videos = urls.map { url in
                let isWatched = savedStatuses[url.path] ?? false
                return VideoItem(url: url, isWatched: isWatched)
            }.sorted { $0.url.lastPathComponent < $1.url.lastPathComponent }
        } catch {
            print("Failed to load videos: \(error)")
        }
    }

    func markAsWatched(_ video: VideoItem) {
        if let index = videos.firstIndex(where: { $0.id == video.id }) {
            videos[index].isWatched = true
            saveStatuses()
        }
    }

    private func loadStatuses() -> [String: Bool] {
        do {
            let data = try Data(contentsOf: saveFileURL)
            let decoder = JSONDecoder()
            return try decoder.decode([String: Bool].self, from: data)
        } catch {
            print("Failed to load statuses: \(error)")
            return [:]
        }
    }

    private func saveStatuses() {
        do {
            let statusMap = Dictionary(uniqueKeysWithValues: videos.map {
                ($0.url.path, $0.isWatched)
            })
            
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            let data = try encoder.encode(statusMap)
            try data.write(to: saveFileURL)
        } catch {
            print("Failed to save statuses: \(error)")
        }
    }

    func loadVideos(_ urls: [URL]) {
        let savedStatuses = loadStatuses()
        videos = urls.map { url in
            let isWatched = savedStatuses[url.path] ?? false
            return VideoItem(url: url, isWatched: isWatched)
        }.sorted { $0.url.lastPathComponent < $1.url.lastPathComponent }
    }
}
