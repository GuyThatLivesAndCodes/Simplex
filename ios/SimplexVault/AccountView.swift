import SwiftUI

/// Account screen: identity, storage, links to Starred and Trash, server setting, sign out.
struct AccountView: View {
    @EnvironmentObject var store: Store
    @State private var showServer = false

    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    Circle().fill(SimplexTheme.accent)
                        .frame(width: 44, height: 44)
                        .overlay(Text(initials).font(.headline).foregroundStyle(.black))
                    VStack(alignment: .leading) {
                        Text(store.account?.display ?? store.account?.username ?? "—")
                            .foregroundStyle(SimplexTheme.text)
                        if let u = store.account?.username {
                            Text("@\(u)").font(.caption).foregroundStyle(SimplexTheme.subtle)
                        }
                    }
                }
            }
            .listRowBackground(SimplexTheme.surface)

            Section {
                NavigationLink { FlatListView(kind: .starred) } label: {
                    Label("Starred", systemImage: "star")
                }
                NavigationLink { FlatListView(kind: .trash) } label: {
                    Label("Trash", systemImage: "trash")
                }
            }
            .listRowBackground(SimplexTheme.surface)

            if let q = store.account?.quota_bytes {
                Section("Storage") {
                    let used = store.files.filter { !$0.isFolder && !$0.isTrashed }.reduce(0) { $0 + $1.size }
                    VStack(alignment: .leading, spacing: 6) {
                        ProgressView(value: Double(used), total: Double(max(q, 1)))
                            .tint(SimplexTheme.accent)
                        Text("\(formatBytes(used)) of \(formatBytes(q))")
                            .font(.caption).foregroundStyle(SimplexTheme.subtle)
                    }
                }
                .listRowBackground(SimplexTheme.surface)
            }

            Section {
                Button { showServer = true } label: {
                    Label("Server", systemImage: "network").foregroundStyle(SimplexTheme.text)
                }
                Button(role: .destructive) {
                    Task { await store.signOut() }
                } label: {
                    Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
            .listRowBackground(SimplexTheme.surface)
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(SimplexTheme.bg)
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showServer) { ServerURLSheet() }
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
                VStack(spacing: 10) {
                    Image(systemName: kind == .starred ? "star" : "trash")
                        .font(.system(size: 38)).foregroundStyle(SimplexTheme.subtle)
                    Text(kind == .starred ? "Nothing starred yet" : "Trash is empty")
                        .foregroundStyle(SimplexTheme.subtle)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(SimplexTheme.bg)
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
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func cell(_ item: FileItem) -> some View {
        HStack(spacing: 12) {
            Thumbnail(item: item).frame(width: 40, height: 40)
                .background(SimplexTheme.surface2, in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).foregroundStyle(SimplexTheme.text).lineLimit(1)
                Text(item.isFolder ? "Folder" : formatBytes(item.size))
                    .font(.caption).foregroundStyle(SimplexTheme.subtle)
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
