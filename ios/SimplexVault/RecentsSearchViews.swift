import SwiftUI

/// Recents — every non-folder file sorted by date, newest first (client-side, no server
/// endpoint needed). Matches the reference: icon + name + "location · relative time".
struct RecentsView: View {
    @EnvironmentObject var store: Store

    private var recents: [FileItem] {
        store.files
            .filter { !$0.isFolder && !$0.isTrashed }
            .sorted { $0.date > $1.date }
    }

    var body: some View {
        Group {
            if recents.isEmpty {
                EmptyState(icon: "clock", title: "No recent files")
            } else {
                List {
                    ForEach(recents.prefix(100).map { $0 }) { item in
                        NavigationLink { FileViewer(item: item) } label: {
                            RecentRow(item: item)
                        }
                        .listRowBackground(SimplexTheme.surface)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .background(SimplexTheme.bg)
        .navigationTitle("Recents")
        .navigationBarTitleDisplayMode(.large)
        .refreshable { await store.refresh() }
    }
}

struct RecentRow: View {
    @EnvironmentObject var store: Store
    let item: FileItem
    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 8).fill(SimplexTheme.surface2)
                Thumbnail(item: item).clipShape(RoundedRectangle(cornerRadius: 8))
            }
            .frame(width: 38, height: 38)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).foregroundStyle(SimplexTheme.text).lineLimit(1)
                Text("\(folderName(item.parent)) · \(relativeDate(item.date))")
                    .font(SimplexTheme.mono(10)).foregroundStyle(SimplexTheme.subtle)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption2).foregroundStyle(SimplexTheme.subtle)
        }
        .padding(.vertical, 3)
    }
    private func folderName(_ parent: String?) -> String {
        guard let parent, let f = store.item(parent) else { return "~" }
        return f.name
    }
}

/// Search — client-side filter of the whole vault by name (and extension), with recent
/// searches saved locally as chips (per the reference).
struct SearchView: View {
    @EnvironmentObject var store: Store
    @State private var query = ""
    @AppStorage("recentSearches") private var recentRaw = ""

    private var recentSearches: [String] {
        recentRaw.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
    }

    private var results: [FileItem] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return [] }
        return store.files
            .filter { !$0.isTrashed && $0.name.lowercased().contains(q) }
            .sorted { !$0.isFolder && $1.isFolder ? false : $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    var body: some View {
        VStack(spacing: 0) {
            // search field
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(SimplexTheme.subtle)
                TextField("Search the vault…", text: $query)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .foregroundStyle(SimplexTheme.text)
                    .submitLabel(.search)
                    .onSubmit { remember(query) }
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(SimplexTheme.subtle) }
                }
            }
            .padding(11)
            .background(SimplexTheme.surface2, in: RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal, 16).padding(.top, 8)

            if query.isEmpty {
                recentChips
                Spacer()
            } else if results.isEmpty {
                EmptyState(icon: "magnifyingglass", title: "No matches for “\(query)”")
            } else {
                List {
                    ForEach(results) { item in
                        NavigationLink {
                            if item.isFolder { FolderView(folder: item.id, title: item.name) }
                            else { FileViewer(item: item) }
                        } label: { RecentRow(item: item) }
                        .listRowBackground(SimplexTheme.surface)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .background(SimplexTheme.bg)
        .navigationTitle("Search")
        .navigationBarTitleDisplayMode(.large)
    }

    private var recentChips: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !recentSearches.isEmpty {
                Text("RECENT SEARCHES")
                    .font(SimplexTheme.mono(10)).foregroundStyle(SimplexTheme.subtle)
                    .padding(.horizontal, 16).padding(.top, 18)
                FlowChips(items: recentSearches) { term in
                    query = term
                } onDelete: { term in
                    remove(term)
                }
                .padding(.horizontal, 16)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func remember(_ term: String) {
        let t = term.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return }
        var list = recentSearches.filter { $0.caseInsensitiveCompare(t) != .orderedSame }
        list.insert(t, at: 0)
        recentRaw = list.prefix(8).joined(separator: "\n")
    }
    private func remove(_ term: String) {
        recentRaw = recentSearches.filter { $0 != term }.joined(separator: "\n")
    }
}

/// Simple wrapping chip row.
struct FlowChips: View {
    let items: [String]
    let onTap: (String) -> Void
    let onDelete: (String) -> Void

    var body: some View {
        // a lazy vertical grid of adaptive chips wraps naturally
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 80), spacing: 8, alignment: .leading)],
                  alignment: .leading, spacing: 8) {
            ForEach(items, id: \.self) { term in
                Button { onTap(term) } label: {
                    Text(term)
                        .font(SimplexTheme.mono(12))
                        .foregroundStyle(SimplexTheme.text)
                        .lineLimit(1)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(SimplexTheme.surface2, in: Capsule())
                }
                .contextMenu {
                    Button(role: .destructive) { onDelete(term) } label: { Label("Remove", systemImage: "xmark") }
                }
            }
        }
    }
}

/// Shared empty-state placeholder.
struct EmptyState: View {
    let icon: String
    let title: String
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: icon).font(.system(size: 40)).foregroundStyle(SimplexTheme.subtle)
            Text(title).foregroundStyle(SimplexTheme.subtle)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(SimplexTheme.bg)
    }
}
