import SwiftUI
import Foundation

enum FileItemType {
    case folder
    case video
}

class FileItem: Identifiable {
    let id = UUID()
    let url: URL
    let name: String
    let type: FileItemType
    var isExpanded: Bool = false
    var children: [FileItem]? = nil
    var isWatched: Bool = false
    
    init(url: URL, type: FileItemType) {
        self.url = url
        self.name = url.lastPathComponent
        self.type = type
    }
}

class FileSystemManager: ObservableObject {
    @Published var rootItems: [FileItem] = []
    private let fileManager = Foundation.FileManager.default
    private let videoExtensions = ["mp4", "mov", "m4v", "avi", "mkv", "wmv"]
    
    func loadFolder(_ url: URL) {
        rootItems = buildFileTree(from: url)
    }
    
    private func buildFileTree(from url: URL) -> [FileItem] {
        var items: [FileItem] = []
        
        guard let contents = try? fileManager.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }
        
        for itemURL in contents.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let isDirectory = (try? itemURL.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            
            if isDirectory {
                let folderItem = FileItem(url: itemURL, type: .folder)
                folderItem.children = buildFileTree(from: itemURL)
                items.append(folderItem)
            } else if videoExtensions.contains(itemURL.pathExtension.lowercased()) {
                items.append(FileItem(url: itemURL, type: .video))
            }
        }
        
        return items
    }
    
    func markAsWatched(_ item: FileItem) {
        item.isWatched = true
    }
}

struct FileTreeView: View {
    let items: [FileItem]
    let onVideoSelected: (FileItem) -> Void
    
    var body: some View {
        List {
            ForEach(items) { item in
                FileItemRow(item: item, onVideoSelected: onVideoSelected)
            }
        }
    }
}

struct FileItemRow: View {
    let item: FileItem
    let onVideoSelected: (FileItem) -> Void
    @State private var isExpanded = false
    
    var body: some View {
        VStack(alignment: .leading) {
            HStack {
                if item.type == .folder {
                    Image(systemName: isExpanded ? "folder.fill" : "folder")
                        .foregroundColor(.blue)
                } else {
                    Image(systemName: "film")
                        .foregroundColor(.gray)
                }
                
                Text(item.name)
                    .lineLimit(1)
                
                Spacer()
                
                if item.type == .video && item.isWatched {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.green)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture {
                if item.type == .folder {
                    isExpanded.toggle()
                } else {
                    onVideoSelected(item)
                }
            }
            
            if item.type == .folder && isExpanded {
                ForEach(item.children ?? []) { child in
                    FileItemRow(item: child, onVideoSelected: onVideoSelected)
                        .padding(.leading, 20)
                }
            }
        }
    }
} 