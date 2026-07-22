import Foundation

/// Thrown for any non-2xx response or transport failure. `needsReauth` is set when
/// the server invalidated our session (a plain 401, or the `code:"KEY"` 401 that the
/// backend returns after a restart when per-user keys aren't RAM-resident yet — in
/// both cases the fix is to send the user back to the login screen).
struct APIError: LocalizedError {
    let status: Int
    let message: String
    let needsReauth: Bool
    var errorDescription: String? { message }
}

/// All networking against the Simplex server. One shared `URLSession` with a
/// persistent cookie store carries the HttpOnly session cookie set by `/api/login`,
/// so every subsequent request is authenticated without us ever touching the cookie
/// value directly (it's HttpOnly — JS/Swift can't read it, but URLSession stores and
/// resends it, which is all we need).
actor API {
    static let shared = API()

    /// Persisted so it survives app relaunch (the picker in Settings writes it).
    private(set) var baseURL: URL

    private let session: URLSession

    private init() {
        let saved = UserDefaults.standard.string(forKey: "serverURL")
        self.baseURL = URL(string: saved ?? "https://data.guythatlives.net")!

        let cfg = URLSessionConfiguration.default
        cfg.httpCookieStorage = HTTPCookieStorage.shared
        cfg.httpCookieAcceptPolicy = .always
        cfg.httpShouldSetCookies = true
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData   // API sends no-store anyway
        cfg.timeoutIntervalForRequest = 30
        cfg.waitsForConnectivity = true
        self.session = URLSession(configuration: cfg)
    }

    func setBaseURL(_ url: URL) {
        baseURL = url
        UserDefaults.standard.set(url.absoluteString, forKey: "serverURL")
    }

    // MARK: - request plumbing

    private func request(_ path: String, method: String = "GET",
                         json body: [String: Any]? = nil) -> URLRequest {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return req
    }

    /// Run a request, mapping non-2xx into `APIError`. Returns the raw data.
    private func run(_ req: URLRequest) async throws -> Data {
        let (data, resp): (Data, URLResponse)
        do {
            (data, resp) = try await session.data(for: req)
        } catch {
            throw APIError(status: -1, message: error.localizedDescription, needsReauth: false)
        }
        guard let http = resp as? HTTPURLResponse else {
            throw APIError(status: -1, message: "Bad response", needsReauth: false)
        }
        if (200...299).contains(http.statusCode) { return data }

        // Try to surface the server's JSON { error, code } message.
        var msg = "HTTP \(http.statusCode)"
        var code: String? = nil
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let e = obj["error"] as? String { msg = e }
            code = obj["code"] as? String
        }
        let reauth = http.statusCode == 401 || code == "KEY"
        throw APIError(status: http.statusCode, message: msg, needsReauth: reauth)
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError(status: -1, message: "Unexpected response format", needsReauth: false) }
    }

    // MARK: - auth

    /// Step 1 of sign-in. Returns `.success` or `.need2fa`.
    func login(username: String, password: String) async throws -> LoginResult {
        let data = try await run(request("/api/login", method: "POST",
                                          json: ["username": username, "password": password]))
        let obj = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        if obj["need2fa"] as? Bool == true, let tk = obj["tk"] as? String {
            return .need2fa(ticket: tk)
        }
        // The full account object rides the login response.
        struct LoginResp: Decodable { let account: Account }
        return .success(try decode(LoginResp.self, from: data).account)
    }

    /// Step 2: submit the TOTP code tied to the ticket from step 1.
    func login2fa(ticket: String, code: String) async throws -> Account {
        let data = try await run(request("/api/login/2fa", method: "POST",
                                          json: ["tk": ticket, "code": code]))
        struct LoginResp: Decodable { let account: Account }
        return try decode(LoginResp.self, from: data).account
    }

    /// Best-effort session check on launch (a stored cookie may still be valid).
    /// `/api/me` nests the account under an `account` key.
    func me() async throws -> Account {
        struct MeResp: Decodable { let account: Account }
        return try decode(MeResp.self, from: try await run(request("/api/me"))).account
    }

    func logout() async {
        _ = try? await run(request("/api/logout", method: "POST"))
    }

    // MARK: - files

    /// The whole vault as a flat list; the UI builds the tree from `parent`.
    func listFiles() async throws -> [FileItem] {
        try decode([FileItem].self, from: try await run(request("/api/files")))
    }

    /// Full body of a content-backed document.
    func docContent(id: String) async throws -> String {
        struct C: Decodable { let content: String }
        return try decode(C.self, from: try await run(request("/api/files/\(id)/content"))).content
    }

    func createFolder(name: String, parent: String?) async throws -> FileItem {
        var body: [String: Any] = ["name": name]
        if let parent { body["parent"] = parent }
        return try decode(FileItem.self, from: try await run(
            request("/api/folders", method: "POST", json: body)))
    }

    /// Rename / star via PATCH (only the fields you pass are changed).
    func patchFile(id: String, changes: [String: Any]) async throws -> FileItem {
        try decode(FileItem.self, from: try await run(
            request("/api/files/\(id)", method: "PATCH", json: changes)))
    }

    func rename(id: String, to name: String) async throws -> FileItem {
        try await patchFile(id: id, changes: ["name": name])
    }

    func setStarred(id: String, _ starred: Bool) async throws -> FileItem {
        try await patchFile(id: id, changes: ["starred": starred])
    }

    /// Move one or more items into `parent` (nil = root).
    func move(ids: [String], to parent: String?) async throws {
        _ = try await run(request("/api/files/move", method: "POST",
                                  json: ["ids": ids, "parent": parent as Any]))
    }

    /// Soft-delete to trash (the default destructive action in the UI).
    func trash(id: String) async throws {
        _ = try await run(request("/api/files/\(id)/trash", method: "POST"))
    }

    func restore(id: String) async throws {
        _ = try await run(request("/api/files/\(id)/restore", method: "POST"))
    }

    /// Permanent delete (used only from the Trash view).
    func deleteForever(id: String) async throws {
        _ = try await run(request("/api/files/\(id)", method: "DELETE"))
    }

    // MARK: - conversion (server ffmpeg via /api/tools/convert)

    /// Result of a save-to-vault conversion.
    struct ConvertResult: Decodable { let ok: Bool; let srcSize: Int?; let outSize: Int?; let file: FileItem }

    /// Convert a vault file to `format` using `tool`, saving the result as a NEW vault
    /// file. Long-running (server ffmpeg); the caller can poll `convertProgress()`.
    func convertToVault(fileId: String, tool: String, format: String) async throws -> FileItem {
        var req = request("/api/tools/convert", method: "POST",
                          json: ["fileId": fileId, "tool": tool, "format": format, "output": "save"])
        req.timeoutInterval = 1200   // conversions can take a while
        let data = try await run(req)
        return try decode(ConvertResult.self, from: data).file
    }

    struct ConvertProgress: Decodable { let active: Bool; let pct: Int?; let phase: String? }
    func convertProgress() async -> ConvertProgress? {
        guard let data = try? await run(request("/api/tools/progress")) else { return nil }
        return try? JSONDecoder().decode(ConvertProgress.self, from: data)
    }

    /// Which convert tools the server has ready (ffmpeg present).
    func toolsAvailable() async -> Bool {
        struct T: Decodable { let ffmpeg: Bool }
        guard let data = try? await run(request("/api/tools")) else { return false }
        return (try? JSONDecoder().decode(T.self, from: data).ffmpeg) ?? false
    }

    // MARK: - appearance prefs

    /// Persist appearance prefs (merged server-side into the account's prefs blob).
    /// Returns the updated account.
    func savePrefs(_ prefs: [String: Any?]) async throws -> Account {
        // JSONSerialization needs NSNull for JSON null (a Swift nil value would be dropped).
        var body: [String: Any] = [:]
        for (k, v) in prefs { body[k] = v ?? NSNull() }
        let data = try await run(request("/api/accounts/me", method: "PATCH",
                                         json: ["prefs": body]))
        struct R: Decodable { let account: Account }
        return try decode(R.self, from: data).account
    }

    // MARK: - Terms of Service

    struct Tos: Decodable { let version: Int; let text: String }
    func fetchTos() async throws -> Tos {
        try decode(Tos.self, from: try await run(request("/api/tos")))
    }
    func acceptTos() async throws -> Account {
        struct R: Decodable { let account: Account }
        return try decode(R.self, from: try await run(request("/api/tos/accept", method: "POST"))).account
    }

    // MARK: - URLs for streaming / download

    /// Absolute URL for streaming a blob (video/audio/image). AVPlayer & AsyncImage
    /// use this directly; the cookie rides along because it's the same session store.
    nonisolated func rawURL(_ item: FileItem) -> URL? {
        guard let u = item.url else { return nil }
        return URL(string: u, relativeTo: baseURLSync)?.absoluteURL
    }

    nonisolated func posterURL(_ item: FileItem) -> URL? {
        guard let u = item.posterUrl else { return nil }
        return URL(string: u, relativeTo: baseURLSync)?.absoluteURL
    }

    nonisolated func coverURL(_ item: FileItem) -> URL? {
        guard let u = item.coverUrl else { return nil }
        return URL(string: u, relativeTo: baseURLSync)?.absoluteURL
    }

    /// Download URL (adds ?dl=1 so the server treats it as a download).
    nonisolated func downloadURL(_ item: FileItem) -> URL? {
        guard let u = item.url else { return nil }
        return URL(string: u + "?dl=1", relativeTo: baseURLSync)?.absoluteURL
    }

    /// A non-actor mirror of baseURL for the nonisolated URL builders. Kept in sync
    /// on every setBaseURL. (URL building must be synchronous for SwiftUI views.)
    nonisolated var baseURLSync: URL {
        URL(string: UserDefaults.standard.string(forKey: "serverURL")
            ?? "https://data.guythatlives.net")!
    }

    // MARK: - download to a local file (for "Save to Files" / share sheet)

    /// Streams a vault file to a temp file on disk and returns its URL.
    func download(_ item: FileItem) async throws -> URL {
        guard let url = downloadURL(item) else {
            throw APIError(status: -1, message: "Not a downloadable file", needsReauth: false)
        }
        let (tmp, resp) = try await session.download(from: url)
        if let http = resp as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw APIError(status: http.statusCode, message: "Download failed",
                           needsReauth: http.statusCode == 401)
        }
        // Move to a named temp file so the share sheet shows the real filename.
        let dest = FileManager.default.temporaryDirectory
            .appendingPathComponent(item.name.isEmpty ? item.id : item.name)
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.moveItem(at: tmp, to: dest)
        return dest
    }
}
