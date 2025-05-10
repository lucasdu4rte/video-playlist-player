import SwiftUI
import AVKit

struct ContentView: View {
    @StateObject private var fileManager = FileSystemManager()
    @State private var player: AVPlayer?
    @State private var currentObserver: NSObjectProtocol?

    var body: some View {
        HStack {
            FileTreeView(items: fileManager.rootItems) { item in
                if item.type == .video {
                    playVideo(item)
                }
            }
            .frame(width: 300)

            VStack {
                if let player = player {
                    VideoPlayer(player: player)
                        .frame(minHeight: 400)
                } else {
                    Text("Select a video to play")
                        .frame(minHeight: 400)
                }
                
                Button("Select Folder") {
                    selectFolder()
                }
                .padding()
            }
        }
    }

    func selectFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false

        if panel.runModal() == .OK, let folderURL = panel.url {
            fileManager.loadFolder(folderURL)
        }
    }

    func playVideo(_ video: FileItem) {
        // Remove previous observer if exists
        if let observer = currentObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        
        // Stop current playback
        player?.pause()
        
        // Create new player and start playback
        player = AVPlayer(url: video.url)
        player?.play()

        // Add new observer
        currentObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: player?.currentItem,
            queue: .main
        ) { _ in
            fileManager.markAsWatched(video)
        }
    }
}
