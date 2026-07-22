import SwiftUI

/// The signed-in shell: a navigation stack over folders, plus the account/trash/starred
/// entry points. Root is the vault root (parent == nil).
struct VaultView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        NavigationStack {
            FolderView(folder: nil, title: store.account?.display ?? "Vault")
        }
        .overlay(alignment: .bottom) { UploadTray() }
    }
}

/// One folder's contents. Pushed onto the stack per subfolder so the back button and
/// breadcrumb come for free.
struct FolderView: View {
    @EnvironmentObject var store: Store
    let folder: String?      // nil = root
    let title: String

    @AppStorage("gridView") private var gridView = true
    @State private var showNewFolder = false
    @State private var newFolderName = ""
    @State private var showImporter = false
    @State private var showPhotoPicker = false
    @State private var renameTarget: FileItem?
    @State private var renameText = ""
    @State private var moveTarget: FileItem?

    private var items: [FileItem] { store.children(of: folder) }

    var body: some View {
        Group {
            if items.isEmpty {
                emptyState
            } else if gridView {
                grid
            } else {
                list
            }
        }
        .background(SimplexTheme.bg)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .refreshable { await store.refresh() }
        .sheet(isPresented: $showImporter) {
            DocumentPicker { urls in
                for url in urls { importFile(url) }
            }
        }
        .sheet(isPresented: $showPhotoPicker) {
            PhotoPicker { url, name, type in
                store.startUpload(fileURL: url, filename: name, type: type, parent: folder)
            }
        }
        .sheet(item: $moveTarget) { target in
            MovePicker(moving: target) { dest in
                Task { await store.move([target.id], to: dest) }
            }
        }
        .alert("New folder", isPresented: $showNewFolder) {
            TextField("Folder name", text: $newFolderName)
            Button("Create") {
                let n = newFolderName.trimmingCharacters(in: .whitespaces)
                newFolderName = ""
                if !n.isEmpty { Task { await store.createFolder(name: n, parent: folder) } }
            }
            Button("Cancel", role: .cancel) { newFolderName = "" }
        }
        .alert("Rename", isPresented: Binding(get: { renameTarget != nil },
                                              set: { if !$0 { renameTarget = nil } })) {
            TextField("Name", text: $renameText)
            Button("Save") {
                if let t = renameTarget {
                    let n = renameText.trimmingCharacters(in: .whitespaces)
                    if !n.isEmpty { Task { await store.rename(t, to: n) } }
                }
                renameTarget = nil
            }
            Button("Cancel", role: .cancel) { renameTarget = nil }
        }
    }

    // MARK: - layouts

    private var grid: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 14)], spacing: 14) {
                ForEach(items) { item in
                    tile(item)
                }
            }
            .padding(14)
        }
    }

    private var list: some View {
        List {
            ForEach(items) { item in
                row(item)
                    .listRowBackground(SimplexTheme.surface)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "tray")
                .font(.system(size: 40))
                .foregroundStyle(SimplexTheme.subtle)
            Text("This folder is empty")
                .foregroundStyle(SimplexTheme.subtle)
            Text("Tap ＋ to upload or make a folder")
                .font(.footnote)
                .foregroundStyle(SimplexTheme.subtle.opacity(0.7))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(SimplexTheme.bg)
    }

    // MARK: - item cells

    @ViewBuilder
    private func tile(_ item: FileItem) -> some View {
        destination(item) {
            VStack(spacing: 8) {
                Thumbnail(item: item)
                    .frame(height: 88)
                    .frame(maxWidth: .infinity)
                    .background(SimplexTheme.surface2, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(alignment: .topTrailing) {
                        if item.isStarred {
                            Image(systemName: "star.fill")
                                .font(.caption2).foregroundStyle(SimplexTheme.accent).padding(5)
                        }
                    }
                Text(item.name)
                    .font(.caption)
                    .foregroundStyle(SimplexTheme.text)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
        }
        .contextMenu { itemMenu(item) }
    }

    @ViewBuilder
    private func row(_ item: FileItem) -> some View {
        destination(item) {
            HStack(spacing: 12) {
                Thumbnail(item: item)
                    .frame(width: 42, height: 42)
                    .background(SimplexTheme.surface2, in: RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.name).foregroundStyle(SimplexTheme.text).lineLimit(1)
                    Text(item.isFolder ? "Folder" : formatBytes(item.size))
                        .font(.caption).foregroundStyle(SimplexTheme.subtle)
                }
                Spacer()
                if item.isStarred {
                    Image(systemName: "star.fill").font(.caption).foregroundStyle(SimplexTheme.accent)
                }
            }
            .padding(.vertical, 4)
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { Task { await store.trash(item) } } label: {
                Label("Trash", systemImage: "trash")
            }
        }
        .contextMenu { itemMenu(item) }
    }

    /// A folder pushes another FolderView; a file opens the appropriate viewer.
    @ViewBuilder
    private func destination<Label: View>(_ item: FileItem, @ViewBuilder label: () -> Label) -> some View {
        if item.isFolder {
            NavigationLink { FolderView(folder: item.id, title: item.name) } label: { label() }
                .buttonStyle(.plain)
        } else {
            NavigationLink { FileViewer(item: item) } label: { label() }
                .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private func itemMenu(_ item: FileItem) -> some View {
        Button { renameTarget = item; renameText = item.name } label: {
            Label("Rename", systemImage: "pencil")
        }
        Button { Task { await store.toggleStar(item) } } label: {
            Label(item.isStarred ? "Unstar" : "Star",
                  systemImage: item.isStarred ? "star.slash" : "star")
        }
        Button { moveTarget = item } label: { Label("Move…", systemImage: "folder") }
        if !item.isFolder {
            Button { downloadAndShare(item) } label: { Label("Save / Share…", systemImage: "square.and.arrow.up") }
        }
        Divider()
        Button(role: .destructive) { Task { await store.trash(item) } } label: {
            Label("Move to Trash", systemImage: "trash")
        }
    }

    // MARK: - toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            if folder == nil { NavigationLink { AccountView() } label: { Image(systemName: "person.circle") } }
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button { gridView.toggle() } label: {
                Image(systemName: gridView ? "list.bullet" : "square.grid.2x2")
            }
            Menu {
                Button { showNewFolder = true } label: { Label("New folder", systemImage: "folder.badge.plus") }
                Button { showPhotoPicker = true } label: { Label("Upload photo / video", systemImage: "photo") }
                Button { showImporter = true } label: { Label("Upload file", systemImage: "doc") }
            } label: {
                Image(systemName: "plus")
            }
        }
    }

    // MARK: - helpers

    private func importFile(_ url: URL) {
        // security-scoped resource from the document picker — copy into temp first.
        let needStop = url.startAccessingSecurityScopedResource()
        defer { if needStop { url.stopAccessingSecurityScopedResource() } }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(url.lastPathComponent)
        try? FileManager.default.removeItem(at: tmp)
        do {
            try FileManager.default.copyItem(at: url, to: tmp)
            store.startUpload(fileURL: tmp, filename: url.lastPathComponent, type: nil, parent: folder)
        } catch {
            store.lastError = "Couldn't read that file."
        }
    }

    @State private var shareURL: URL?
    private func downloadAndShare(_ item: FileItem) {
        Task {
            do {
                let local = try await API.shared.download(item)
                await MainActor.run { presentShare(local) }
            } catch { store.handle(error) }
        }
    }

    private func presentShare(_ url: URL) {
        let av = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let root = scene.windows.first?.rootViewController else { return }
        // present from the topmost controller
        var top = root
        while let p = top.presentedViewController { top = p }
        av.popoverPresentationController?.sourceView = top.view
        top.present(av, animated: true)
    }
}
