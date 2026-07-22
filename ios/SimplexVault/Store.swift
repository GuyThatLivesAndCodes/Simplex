import Foundation
import SwiftUI

/// App-wide state. Owns auth, the full flat file list, and the derived folder view.
/// Views observe this; all mutations funnel through here so a single 401→re-login
/// path is enforced (`handle(_:)`).
@MainActor
final class Store: ObservableObject {

    enum Phase { case loading, signedOut, signedIn }

    @Published var phase: Phase = .loading
    @Published var account: Account?

    /// The whole vault, flat. `children(of:)` slices it per folder.
    @Published private(set) var files: [FileItem] = []
    @Published var isRefreshing = false
    @Published var lastError: String?

    /// Active upload tasks (shown in a small tray while running).
    @Published var uploads: [UploadTask] = []

    // MARK: - launch

    /// Try to resume a stored session; otherwise show the login screen.
    func bootstrap() async {
        do {
            let me = try await API.shared.me()
            account = me
            phase = .signedIn
            await refresh()
        } catch {
            phase = .signedOut
        }
    }

    // MARK: - auth

    func completeSignIn(_ acct: Account) async {
        account = acct
        phase = .signedIn
        await refresh()
    }

    func signOut() async {
        await API.shared.logout()
        account = nil
        files = []
        phase = .signedOut
    }

    // MARK: - data

    func refresh() async {
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            files = try await API.shared.listFiles()
            lastError = nil
        } catch {
            handle(error)
        }
    }

    /// Non-trashed children of a folder (nil = root), folders first then by name.
    func children(of parent: String?) -> [FileItem] {
        files.filter { $0.parent == parent && !$0.isTrashed }
            .sorted(by: Self.sortRule)
    }

    /// Everything currently in the trash (flat — trash is shown as one list).
    var trashed: [FileItem] {
        files.filter { $0.isTrashed }.sorted(by: Self.sortRule)
    }

    var starred: [FileItem] {
        files.filter { $0.isStarred && !$0.isTrashed }.sorted(by: Self.sortRule)
    }

    func item(_ id: String) -> FileItem? { files.first { $0.id == id } }

    /// Full folder path from root to `parent`, for breadcrumbs.
    func breadcrumb(to parent: String?) -> [FileItem] {
        var chain: [FileItem] = []
        var cur = parent
        while let id = cur, let f = item(id) {
            chain.insert(f, at: 0)
            cur = f.parent
        }
        return chain
    }

    private static func sortRule(_ a: FileItem, _ b: FileItem) -> Bool {
        if a.isFolder != b.isFolder { return a.isFolder }   // folders first
        return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
    }

    // MARK: - mutations (optimistic-ish: refetch after each)

    func createFolder(name: String, parent: String?) async {
        do { _ = try await API.shared.createFolder(name: name, parent: parent); await refresh() }
        catch { handle(error) }
    }

    func rename(_ item: FileItem, to name: String) async {
        do { _ = try await API.shared.rename(id: item.id, to: name); await refresh() }
        catch { handle(error) }
    }

    func toggleStar(_ item: FileItem) async {
        do { _ = try await API.shared.setStarred(id: item.id, !item.isStarred); await refresh() }
        catch { handle(error) }
    }

    func move(_ ids: [String], to parent: String?) async {
        do { try await API.shared.move(ids: ids, to: parent); await refresh() }
        catch { handle(error) }
    }

    func trash(_ item: FileItem) async {
        do { try await API.shared.trash(id: item.id); await refresh() }
        catch { handle(error) }
    }

    func restore(_ item: FileItem) async {
        do { try await API.shared.restore(id: item.id); await refresh() }
        catch { handle(error) }
    }

    func deleteForever(_ item: FileItem) async {
        do { try await API.shared.deleteForever(id: item.id); await refresh() }
        catch { handle(error) }
    }

    // MARK: - upload

    /// Kick off an upload of a local file; tracks it in `uploads` with progress.
    func startUpload(fileURL: URL, filename: String, type: String?, parent: String?) {
        let task = UploadTask(filename: filename)
        uploads.append(task)
        Task {
            do {
                _ = try await Uploader.upload(fileURL: fileURL, filename: filename,
                                              type: type, parent: parent) { frac in
                    task.fractionComplete = frac
                }
                task.isDone = true
                await refresh()
            } catch {
                task.error = (error as? APIError)?.message ?? error.localizedDescription
                if let e = error as? APIError, e.needsReauth { phase = .signedOut }
            }
            // clear finished/failed tasks after a moment
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            uploads.removeAll { $0.id == task.id }
        }
    }

    // MARK: - errors

    /// One place to react to an API error. A session-invalidating error (plain 401,
    /// or the post-restart `KEY` 401) drops us back to the login screen; everything
    /// else surfaces as a message.
    func handle(_ error: Error) {
        if let e = error as? APIError, e.needsReauth {
            account = nil
            files = []
            phase = .signedOut
            lastError = "Your session ended — please sign in again."
        } else {
            lastError = (error as? APIError)?.message ?? error.localizedDescription
        }
    }
}
