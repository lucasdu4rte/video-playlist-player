//
//  VideoPlaylistPlayerApp.swift
//  VideoPlaylistPlayer
//
//  Created by Lucas Duarte on 10/05/25.
//

import SwiftUI

@main
struct VideoPlaylistPlayerApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .defaultSize(width: 1100, height: 680)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
    }
}
