import SwiftUI

/// The signed-in shell: a bottom tab bar (Files / Recents / Search / Account), matching
/// the reference design. Each tab is its own navigation stack. The upload tray floats
/// above everything.
struct VaultView: View {
    @EnvironmentObject var store: Store
    @ObservedObject private var appr = Appearance.shared
    @State private var tab = 0

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack { FolderView(folder: nil, title: "Files") }
                .tabItem { Label("Files", systemImage: "folder") }
                .tag(0)

            NavigationStack { RecentsView() }
                .tabItem { Label("Recents", systemImage: "clock") }
                .tag(1)

            NavigationStack { SearchView() }
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
                .tag(2)

            NavigationStack { AccountView() }
                .tabItem { Label("Account", systemImage: "person") }
                .tag(3)
        }
        .tint(SimplexTheme.accent)
        .overlay(alignment: .bottom) { UploadTray().padding(.bottom, 52) }
        .sheet(isPresented: $store.showTosSheet) {
            TosSheet { accepted in await store.resolveTos(accepted: accepted) }
                .interactiveDismissDisabled()
        }
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
    @State private var convertTarget: FileItem?
    // fullscreen media gallery: non-nil items = presented, starting at galleryIndex
    @State private var galleryItems: [FileItem]?
    @State private var galleryIndex = 0

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
        .sheet(item: $convertTarget) { target in
            ConvertSheet(item: target)
        }
        .fullScreenCover(isPresented: Binding(get: { galleryItems != nil },
                                              set: { if !$0 { galleryItems = nil } })) {
            if let media = galleryItems {
                MediaGallery(items: media, index: galleryIndex)
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
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)], spacing: 14) {
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
            VStack(alignment: .leading, spacing: 8) {
                ZStack {
                    if item.isFolder {
                        // colored folder tile with a folder glyph, per the reference
                        RoundedRectangle(cornerRadius: 12)
                            .fill(SimplexTheme.accent.opacity(0.14))
                        Image(systemName: "folder.fill")
                            .font(.system(size: 34))
                            .foregroundStyle(SimplexTheme.accent)
                    } else {
                        RoundedRectangle(cornerRadius: 12).fill(SimplexTheme.surface2)
                        Thumbnail(item: item)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        // type badge, top-left
                        if let badge = typeBadge(for: item) {
                            VStack { HStack {
                                Text(badge)
                                    .font(SimplexTheme.mono(9, weight: .semibold))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 5).padding(.vertical, 2)
                                    .background(typeTint(for: item), in: RoundedRectangle(cornerRadius: 4))
                                Spacer()
                            }; Spacer() }.padding(7)
                        }
                    }
                    if item.isStarred {
                        VStack { HStack { Spacer()
                            Image(systemName: "star.fill").font(.caption2).foregroundStyle(SimplexTheme.accent)
                        }; Spacer() }.padding(7)
                    }
                    // videos with a saved spot show a "resume" chip
                    if item.kind == .video && VideoProgress.hasResume(for: item.id) {
                        VStack { Spacer(); HStack {
                            Label("Resume", systemImage: "play.fill")
                                .font(SimplexTheme.mono(9, weight: .semibold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6).padding(.vertical, 3)
                                .background(.black.opacity(0.6), in: Capsule())
                            Spacer()
                        } }.padding(7)
                    }
                }
                .frame(height: 128)
                .frame(maxWidth: .infinity)

                Text(item.name)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(SimplexTheme.text)
                    .lineLimit(1)
                Text(item.isFolder ? "\(childCount(item)) items" : metaLine(item))
                    .font(SimplexTheme.mono(10))
                    .foregroundStyle(SimplexTheme.subtle)
                    .lineLimit(1)
            }
        }
        .contextMenu { itemMenu(item) }
    }

    @ViewBuilder
    private func row(_ item: FileItem) -> some View {
        destination(item) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(item.isFolder ? SimplexTheme.accent.opacity(0.14) : SimplexTheme.surface2)
                    if item.isFolder {
                        Image(systemName: "folder.fill").foregroundStyle(SimplexTheme.accent)
                    } else {
                        Thumbnail(item: item).clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                }
                .frame(width: 42, height: 42)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.name).foregroundStyle(SimplexTheme.text).lineLimit(1)
                    Text(item.isFolder ? "\(childCount(item)) items" : metaLine(item))
                        .font(SimplexTheme.mono(10)).foregroundStyle(SimplexTheme.subtle)
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

    private func childCount(_ folder: FileItem) -> Int {
        store.children(of: folder.id).count
    }

    /// Images in this folder, in display order — the photo gallery swipes through these.
    private var folderPhotos: [FileItem] {
        items.filter { $0.kind == .image }
    }

    /// Folders push another FolderView. IMAGES open the fullscreen swipe gallery. VIDEOS
    /// open a standard AVPlayer page with the full native control bar (scrubber, skip,
    /// speed, AirPlay) and a Fullscreen button — the reduced/swipe behavior only applies
    /// to the fullscreen route. Everything else opens the in-place FileViewer.
    @ViewBuilder
    private func destination<Label: View>(_ item: FileItem, @ViewBuilder label: () -> Label) -> some View {
        if item.isFolder {
            NavigationLink { FolderView(folder: item.id, title: item.name) } label: { label() }
                .buttonStyle(.plain)
        } else if item.kind == .image {
            Button {
                if let start = folderPhotos.firstIndex(where: { $0.id == item.id }) {
                    galleryItems = folderPhotos
                    galleryIndex = start
                }
            } label: { label() }
            .buttonStyle(.plain)
        } else if item.kind == .video {
            NavigationLink { VideoPage(item: item) } label: { label() }
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
            if ConvertKit.canConvert(item) {
                Button { convertTarget = item } label: { Label("Convert…", systemImage: "arrow.triangle.2.circlepath") }
            }
        }
        Divider()
        Button(role: .destructive) { Task { await store.trash(item) } } label: {
            Label("Move to Trash", systemImage: "trash")
        }
    }

    // MARK: - toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
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
