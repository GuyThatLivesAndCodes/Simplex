import SwiftUI

/// A folder tree picker for moving an item. Shows the vault root plus every folder
/// (except the item being moved and its own descendants, which would be invalid
/// destinations). Tapping a row selects it as the destination.
struct MovePicker: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    let moving: FileItem
    let onPick: (String?) -> Void

    var body: some View {
        NavigationStack {
            List {
                Button {
                    onPick(nil); dismiss()
                } label: {
                    Label("Vault root", systemImage: "house")
                        .foregroundStyle(SimplexTheme.text)
                }
                .listRowBackground(SimplexTheme.surface)

                ForEach(destinations) { folder in
                    Button {
                        onPick(folder.id); dismiss()
                    } label: {
                        HStack {
                            ForEach(0..<depth(of: folder), id: \.self) { _ in
                                Spacer().frame(width: 14)
                            }
                            Label(folder.name, systemImage: "folder")
                                .foregroundStyle(SimplexTheme.text)
                        }
                    }
                    .listRowBackground(SimplexTheme.surface)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(SimplexTheme.bg)
            .navigationTitle("Move “\(moving.name)”")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    /// All folders that are valid move targets (not the item itself, not inside it).
    private var destinations: [FileItem] {
        let invalid = descendantFolderIDs(of: moving.id).union([moving.id])
        return store.files
            .filter { $0.isFolder && !$0.isTrashed && !invalid.contains($0.id) }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private func descendantFolderIDs(of id: String) -> Set<String> {
        var out: Set<String> = []
        var stack = [id]
        while let cur = stack.popLast() {
            for f in store.files where f.parent == cur && f.isFolder {
                if out.insert(f.id).inserted { stack.append(f.id) }
            }
        }
        return out
    }

    private func depth(of folder: FileItem) -> Int {
        var d = 0; var cur = folder.parent
        while let id = cur, let f = store.item(id) { d += 1; cur = f.parent }
        return min(d, 6)
    }
}

/// A small floating tray showing active uploads with progress bars.
struct UploadTray: View {
    @EnvironmentObject var store: Store

    var body: some View {
        if !store.uploads.isEmpty {
            VStack(spacing: 8) {
                ForEach(store.uploads) { task in
                    HStack(spacing: 10) {
                        if task.error != nil {
                            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
                        } else if task.isDone {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                        } else {
                            ProgressView(value: task.fractionComplete).frame(width: 90).tint(SimplexTheme.accent)
                        }
                        VStack(alignment: .leading, spacing: 1) {
                            Text(task.filename).font(.caption).lineLimit(1).foregroundStyle(SimplexTheme.text)
                            if let e = task.error {
                                Text(e).font(.caption2).foregroundStyle(.red).lineLimit(1)
                            } else {
                                Text(task.isDone ? "Uploaded" : "\(Int(task.fractionComplete * 100))%")
                                    .font(.caption2).foregroundStyle(SimplexTheme.subtle)
                            }
                        }
                        Spacer()
                    }
                    .padding(10)
                    .background(SimplexTheme.surface2, in: RoundedRectangle(cornerRadius: 10))
                }
            }
            .padding(12)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
    }
}
