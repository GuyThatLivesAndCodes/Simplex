import SwiftUI

/// Account screen (a tab): identity, storage broken down by kind, security (Face ID),
/// appearance, Starred, Trash, sign out. Styled after the reference image.
struct AccountView: View {
    @EnvironmentObject var store: Store
    @ObservedObject private var appr = Appearance.shared

    var body: some View {
        List {
            // identity
            Section {
                HStack(spacing: 14) {
                    Circle().fill(SimplexTheme.accent)
                        .frame(width: 46, height: 46)
                        .overlay(Text(initials).font(.headline).foregroundStyle(.black))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(store.account?.display ?? store.account?.username ?? "—")
                            .font(.headline).foregroundStyle(SimplexTheme.text)
                        Text(API.shared.baseURLSync.host ?? "")
                            .font(SimplexTheme.mono(11)).foregroundStyle(SimplexTheme.subtle)
                    }
                }
            }
            .listRowBackground(SimplexTheme.surface)

            storageSection

            // security
            Section("Security") {
                Toggle(isOn: $appr.faceIDLock) {
                    Label("Unlock with Face ID", systemImage: "faceid")
                }
                .tint(SimplexTheme.accent)
                .onChange(of: appr.faceIDLock) { _ in appr.persistLocal() }
            }
            .listRowBackground(SimplexTheme.surface)

            // library
            Section {
                NavigationLink { FlatListView(kind: .starred) } label: {
                    Label("Starred", systemImage: "star")
                }
                NavigationLink { FlatListView(kind: .trash) } label: {
                    Label("Trash", systemImage: "trash")
                }
            }
            .listRowBackground(SimplexTheme.surface)

            // preferences
            Section("Preferences") {
                NavigationLink { AppearanceView() } label: {
                    HStack {
                        Label("Appearance", systemImage: "paintbrush")
                        Spacer()
                        Text(themeLabel).font(SimplexTheme.mono(11)).foregroundStyle(SimplexTheme.subtle)
                    }
                }
            }
            .listRowBackground(SimplexTheme.surface)

            Section {
                Button { store.showServer = true } label: {
                    Label("Server", systemImage: "network").foregroundStyle(SimplexTheme.text)
                }
                Button(role: .destructive) {
                    Task { await store.signOut() }
                } label: {
                    Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
            .listRowBackground(SimplexTheme.surface)

            Section {
                Text("SIMPLEX · v1.0")
                    .font(SimplexTheme.mono(10)).foregroundStyle(SimplexTheme.subtle)
                    .frame(maxWidth: .infinity)
            }
            .listRowBackground(Color.clear)
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(SimplexTheme.bg)
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.large)
        .sheet(isPresented: $store.showServer) { ServerURLSheet() }
    }

    // storage meter split into Docs / Images / Media, like the reference
    private var storageSection: some View {
        Section("Storage") {
            let used = usedBreakdown()
            VStack(alignment: .leading, spacing: 8) {
                if let q = store.account?.quota_bytes {
                    HStack {
                        Text(formatBytes(used.total)).font(.headline).foregroundStyle(SimplexTheme.text)
                        Spacer()
                        Text("of \(formatBytes(q))").font(SimplexTheme.mono(11)).foregroundStyle(SimplexTheme.subtle)
                    }
                    // segmented bar
                    GeometryReader { geo in
                        let w = geo.size.width
                        HStack(spacing: 1.5) {
                            seg(used.docs, q, w, Color(hex: 0x5aa9e6))
                            seg(used.images, q, w, Color(hex: 0x7ed957))
                            seg(used.media, q, w, Color(hex: 0xb07ee6))
                            Spacer(minLength: 0)
                        }
                    }
                    .frame(height: 8)
                    .background(SimplexTheme.surface2, in: Capsule())
                    .clipShape(Capsule())
                    HStack(spacing: 14) {
                        legend("Docs", Color(hex: 0x5aa9e6))
                        legend("Images", Color(hex: 0x7ed957))
                        legend("Media", Color(hex: 0xb07ee6))
                    }
                    .font(SimplexTheme.mono(10)).foregroundStyle(SimplexTheme.subtle)
                }
            }
            .padding(.vertical, 2)
        }
        .listRowBackground(SimplexTheme.surface)
    }

    private func seg(_ bytes: Int, _ quota: Int, _ width: CGFloat, _ color: Color) -> some View {
        let frac = quota > 0 ? min(1, Double(bytes) / Double(quota)) : 0
        return color.frame(width: max(0, width * frac))
    }
    private func legend(_ label: String, _ color: Color) -> some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label)
        }
    }

    private struct Breakdown { var docs = 0; var images = 0; var media = 0; var total: Int { docs + images + media } }
    private func usedBreakdown() -> Breakdown {
        var b = Breakdown()
        for f in store.files where !f.isFolder && !f.isTrashed {
            switch f.kind {
            case .image: b.images += f.size
            case .video, .audio: b.media += f.size
            default: b.docs += f.size
            }
        }
        return b
    }

    private var themeLabel: String {
        AppearanceCatalog.themes.first { $0.id == appr.themeId }?.label ?? "Dark"
    }
    private var initials: String {
        let name = store.account?.display ?? store.account?.username ?? "?"
        return String(name.prefix(1)).uppercased()
    }
}

/// A flat (non-hierarchical) list — used for Starred and Trash, which cut across folders.
struct FlatListView: View {
    enum Kind { case starred, trash }
    @EnvironmentObject var store: Store
    let kind: Kind

    private var items: [FileItem] { kind == .starred ? store.starred : store.trashed }
    private var title: String { kind == .starred ? "Starred" : "Trash" }

    var body: some View {
        Group {
            if items.isEmpty {
                EmptyState(icon: kind == .starred ? "star" : "trash",
                           title: kind == .starred ? "Nothing starred yet" : "Trash is empty")
            } else {
                List {
                    ForEach(items) { item in
                        cell(item).listRowBackground(SimplexTheme.surface)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .background(SimplexTheme.bg)
            }
        }
        .background(SimplexTheme.bg)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func cell(_ item: FileItem) -> some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 8).fill(SimplexTheme.surface2)
                Thumbnail(item: item).clipShape(RoundedRectangle(cornerRadius: 8))
            }.frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).foregroundStyle(SimplexTheme.text).lineLimit(1)
                Text(item.isFolder ? "Folder" : metaLine(item))
                    .font(SimplexTheme.mono(10)).foregroundStyle(SimplexTheme.subtle)
            }
            Spacer()
        }
        .swipeActions(edge: .trailing) {
            if kind == .trash {
                Button(role: .destructive) { Task { await store.deleteForever(item) } } label: {
                    Label("Delete", systemImage: "trash.fill")
                }
                Button { Task { await store.restore(item) } } label: {
                    Label("Restore", systemImage: "arrow.uturn.backward")
                }.tint(SimplexTheme.accent)
            } else {
                Button { Task { await store.toggleStar(item) } } label: {
                    Label("Unstar", systemImage: "star.slash")
                }.tint(SimplexTheme.accent)
            }
        }
    }
}
