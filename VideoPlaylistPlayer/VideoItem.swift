import Foundation

struct VideoItem: Identifiable {
    let id = UUID()
    let url: URL
    var isWatched: Bool = false
}
