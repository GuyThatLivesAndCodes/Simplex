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

    /// The one and only Simplex server. This app IS Simplex — it talks to
    /// data.guythatlives.net and nowhere else. (Other Simplex-based servers, if any,
    /// would ship their own app; a server picker was removed on purpose.)
    static let serverURL = URL(string: "https://data.guythatlives.net")!

    let baseURL = API.serverURL

    private let session: URLSession

    private init() {
        let cfg = URLSessionConfiguration.default
        cfg.httpCookieStorage = HTTPCookieStorage.shared
        cfg.httpCookieAcceptPolicy = .always
        cfg.httpShouldSetCookies = true
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData   // API sends no-store anyway
        cfg.timeoutIntervalForRequest = 30
        cfg.waitsForConnectivity = true
        self.session = URLSession(configuration: cfg)
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
        let acct = try decode(LoginResp.self, from: data).account
        SessionStore.persistFromStorage()   // keep the session for future launches
        return .success(acct)
    }

    /// Step 2: submit the TOTP code tied to the ticket from step 1.
    func login2fa(ticket: String, code: String) async throws -> Account {
        let data = try await run(request("/api/login/2fa", method: "POST",
                                          json: ["tk": ticket, "code": code]))
        struct LoginResp: Decodable { let account: Account }
        let acct = try decode(LoginResp.self, from: data).account
        SessionStore.persistFromStorage()
        return acct
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

    /// Move one or more items into `parent` (nil = root). Use NSNull for root so
    /// JSONSerialization emits an explicit null rather than throwing on a boxed nil.
    func move(ids: [String], to parent: String?) async throws {
        _ = try await run(request("/api/files/move", method: "POST",
                                  json: ["ids": ids, "parent": parent ?? NSNull()]))
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

    // MARK: - AI Image Editing (xAI Grok Imagine via /api/ai/image/*)

    /// Response of starting an edit: the server debits the token and runs a DETACHED
    /// job that finishes even if we disconnect. `jobId` is polled via `imageJob`.
    struct ImageEditStart: Decodable { let ok: Bool; let jobId: String; let quality: String; let cost: Int; let tokens: ImgEditTokens? }
    /// One poll of an edit job. `status` is running|done|error; `file` is the saved
    /// result once done; `tokens` is the refreshed daily allowance.
    struct ImageJob: Decodable { let id: String; let status: String; let phase: String?; let error: String?; let file: FileItem?; let quality: String?; let cost: Int?; let tokens: ImgEditTokens? }

    /// Kick off an edit. Returns immediately with a jobId (the work continues server-side).
    func startImageEdit(fileId: String, quality: String, prompt: String) async throws -> ImageEditStart {
        var req = request("/api/ai/image/edit", method: "POST",
                          json: ["fileId": fileId, "quality": quality, "prompt": prompt])
        req.timeoutInterval = 60
        return try decode(ImageEditStart.self, from: try await run(req))
    }
    /// Poll a job's status once.
    func imageJob(_ id: String) async throws -> ImageJob {
        try decode(ImageJob.self, from: try await run(request("/api/ai/image/job/\(id)")))
    }
    /// The account's current daily image-edit token allowance.
    func imageTokens() async throws -> ImgEditTokens {
        try decode(ImgEditTokens.self, from: try await run(request("/api/ai/image/tokens")))
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

    // MARK: - Habit backups (the Habit system is local-first; the server only backs up)

    struct HabitBackupMeta: Decodable, Identifiable { let day: String; let updated: Double; let habitCount: Int
        var id: String { day } }

    /// List available backup days (metadata only), newest first.
    func listHabitBackups() async throws -> [HabitBackupMeta] {
        struct R: Decodable { let backups: [HabitBackupMeta] }
        return try decode(R.self, from: try await run(request("/api/habits/backups"))).backups
    }

    /// Push a snapshot for a day (upsert). `json` is the serialized HabitDoc.
    func putHabitBackup(day: String, json: String) async throws {
        _ = try await run(request("/api/habits/backup", method: "PUT", json: ["day": day, "data": json]))
    }

    /// Fetch a day's snapshot (or "latest") and decode it into a HabitDoc.
    func getHabitBackup(day: String) async throws -> HabitDoc {
        struct R: Decodable { let day: String; let updated: Double; let data: String }
        let r = try decode(R.self, from: try await run(request("/api/habits/backup/\(day)")))
        guard let doc = HabitLocalStore.decodeSnapshot(r.data) else {
            throw APIError(status: -1, message: "Corrupt backup", needsReauth: false)
        }
        return doc
    }

    /// The most recent backup (used to auto-restore on a fresh install). Returns nil if
    /// there are no backups yet.
    func latestHabitBackup() async throws -> HabitDoc? {
        do { return try await getHabitBackup(day: "latest") }
        catch let e as APIError where e.status == 404 { return nil }
    }

    // MARK: - Neural models (the Neural system: local-first, synced via /api/networks)

    struct NetMeta: Decodable, Identifiable { let id: String; let kind: String; let name: String; let updated: Double }

    /// List the account's saved networks (metadata only). Filter to our kind server-side
    /// isn't available, so we filter client-side.
    func listNetworks() async throws -> [NetMeta] {
        try decode([NetMeta].self, from: try await run(request("/api/networks")))
    }
    /// Fetch a full model doc. `data` is our NeuralDoc JSON (as a nested object).
    func getNetworkDoc(_ id: String) async throws -> (name: String, updated: Double, doc: NeuralDoc?) {
        let data = try await run(request("/api/networks/\(id)"))
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw APIError(status: -1, message: "bad response", needsReauth: false)
        }
        let name = obj["name"] as? String ?? "Untitled model"
        let updated = (obj["updated"] as? Double) ?? 0
        var doc: NeuralDoc? = nil
        if let dataObj = obj["data"], !(dataObj is NSNull),
           let raw = try? JSONSerialization.data(withJSONObject: dataObj) {
            doc = try? JSONDecoder().decode(NeuralDoc.self, from: raw)
        }
        return (name, updated, doc)
    }
    /// Create a network (kind llm2). Returns the new id.
    func createNetwork(name: String, doc: NeuralDoc) async throws -> String {
        let dataObj = try jsonObject(doc)
        let data = try await run(request("/api/networks", method: "POST",
                                         json: ["kind": "llm2", "name": name, "data": dataObj]))
        struct R: Decodable { let id: String }
        return try decode(R.self, from: data).id
    }
    /// Update a network's name + data.
    func updateNetwork(_ id: String, name: String, doc: NeuralDoc) async throws {
        let dataObj = try jsonObject(doc)
        _ = try await run(request("/api/networks/\(id)", method: "PATCH",
                                  json: ["name": name, "data": dataObj]))
    }
    func deleteNetwork(_ id: String) async throws {
        _ = try await run(request("/api/networks/\(id)", method: "DELETE"))
    }
    /// Encode a Codable into a JSON object (dictionary) for embedding in a request body.
    private func jsonObject<T: Encodable>(_ value: T) throws -> Any {
        let data = try JSONEncoder().encode(value)
        return try JSONSerialization.jsonObject(with: data)
    }

    // MARK: - Connect (private rooms: calls + chat)
    //
    // Rooms are reachable ONLY by their 5-character code — there is no endpoint that
    // lists rooms you haven't joined. `joinRoom` is what converts a code into
    // membership; everything else requires membership already.

    func connectRooms() async throws -> [ConnectRoom] {
        try decode(ConnectRoomsResponse.self, from: try await run(request("/api/connect/rooms"))).rooms
    }

    func createConnectRoom(name: String, topic: String? = nil) async throws -> ConnectRoom {
        var body: [String: Any] = ["name": name]
        if let topic, !topic.isEmpty { body["topic"] = topic }
        return try decode(ConnectRoomResponse.self,
                          from: try await run(request("/api/connect/rooms", method: "POST", json: body))).room
    }

    /// Join by code. Throws APIError with the server's message for a bad/locked code.
    func joinConnectRoom(code: String) async throws -> ConnectRoom {
        try decode(ConnectRoomResponse.self,
                   from: try await run(request("/api/connect/join", method: "POST", json: ["code": code]))).room
    }

    func connectRoom(_ id: String) async throws -> ConnectRoom {
        try decode(ConnectRoomResponse.self, from: try await run(request("/api/connect/rooms/\(id)"))).room
    }

    func updateConnectRoom(_ id: String, name: String, topic: String?, locked: Bool) async throws -> ConnectRoom {
        var body: [String: Any] = ["name": name, "locked": locked]
        body["topic"] = topic ?? ""
        return try decode(ConnectRoomResponse.self,
                          from: try await run(request("/api/connect/rooms/\(id)", method: "PATCH", json: body))).room
    }

    /// Deletes the room AND its whole chat history (server does it in one transaction).
    func deleteConnectRoom(_ id: String) async throws {
        _ = try await run(request("/api/connect/rooms/\(id)", method: "DELETE"))
    }

    func leaveConnectRoom(_ id: String) async throws {
        _ = try await run(request("/api/connect/rooms/\(id)/leave", method: "POST"))
    }

    func removeConnectMember(room: String, account: String) async throws {
        _ = try await run(request("/api/connect/rooms/\(room)/members/\(account)", method: "DELETE"))
    }

    // ---- chat ----

    /// Full recent history when `since` is nil, or only what's new since a timestamp.
    func connectMessages(room: String, since: Double? = nil) async throws -> [ConnectMessage] {
        var path = "/api/connect/rooms/\(room)/messages"
        if let since, since > 0 { path += "?since=\(Int(since))" }
        return try decode(ConnectMessagesResponse.self, from: try await run(request(path))).messages
    }

    func sendConnectMessage(room: String, text: String, replyTo: String? = nil) async throws -> ConnectMessage {
        var body: [String: Any] = ["text": text]
        if let replyTo { body["replyTo"] = replyTo }
        return try decode(ConnectMessageResponse.self,
                          from: try await run(request("/api/connect/rooms/\(room)/messages", method: "POST", json: body))).message
    }

    func editConnectMessage(room: String, id: String, text: String) async throws -> ConnectMessage {
        try decode(ConnectMessageResponse.self,
                   from: try await run(request("/api/connect/rooms/\(room)/messages/\(id)",
                                               method: "PATCH", json: ["text": text]))).message
    }

    func deleteConnectMessage(room: String, id: String) async throws {
        _ = try await run(request("/api/connect/rooms/\(room)/messages/\(id)", method: "DELETE"))
    }

    /// Toggle one emoji on a message. `remove: true` takes your own reaction back.
    func reactConnectMessage(room: String, id: String, emoji: String, remove: Bool) async throws -> ConnectMessage {
        try decode(ConnectMessageResponse.self,
                   from: try await run(request("/api/connect/rooms/\(room)/messages/\(id)/react",
                                               method: "POST", json: ["emoji": emoji, "remove": remove]))).message
    }

    /// The in-app call page. The live call runs in a WKWebView pointed here because
    /// WebRTC on iOS is only available inside a web view — see ConnectCallView.
    /// `nonisolated` + `static` so a SwiftUI view body can build it synchronously:
    /// `API` is an actor, so an instance method here would need `await`.
    nonisolated static func connectCallURL(room: String) -> URL {
        serverURL.appendingPathComponent("connect/room/\(room)")
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

    /// The fixed server URL, available synchronously for the nonisolated URL builders
    /// (SwiftUI views build URLs without awaiting). Always the one Simplex server.
    nonisolated var baseURLSync: URL { API.serverURL }

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
