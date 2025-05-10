import SwiftUI
import AVKit

struct VideoPlayerView: NSViewRepresentable {
    @Binding var player: AVPlayer?
    
    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.player = player
        view.controlsStyle = .floating
        return view
    }
    
    func updateNSView(_ nsView: AVPlayerView, context: Context) {
        nsView.player = player
    }
}
