import Foundation

/// Upload progress, observable so the UI can show a bar.
@MainActor
final class UploadTask: ObservableObject, Identifiable {
    let id = UUID()
    let filename: String
    @Published var fractionComplete: Double = 0
    @Published var isDone = false
    @Published var error: String?
    init(filename: String) { self.filename = filename }
}

/// Handles pushing a local file into the vault. Small files go through the single-shot
/// `POST /api/files` multipart endpoint; large ones use the chunked protocol
/// (`init` → `PUT` per chunk → `complete`) that exists to stay under Cloudflare's
/// ~100 MB request-body cap. The server dictates the chunk size, so we honor it.
enum Uploader {

    /// Files at/under this size take the simple multipart path. Comfortably below the
    /// Cloudflare limit; anything larger switches to chunked.
    static let singleShotMax = 8 * 1024 * 1024   // 8 MB

    /// Upload a file already present on disk (e.g. a temp copy from the photo picker).
    /// `progress` is called on the main actor with 0…1.
    static func upload(fileURL: URL, filename: String, type: String?, parent: String?,
                       progress: @escaping @MainActor (Double) -> Void) async throws -> FileItem {
        let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL.path)
        let size = (attrs?[.size] as? Int) ?? 0
        if size <= singleShotMax {
            return try await singleShot(fileURL: fileURL, filename: filename, type: type,
                                        parent: parent, progress: progress)
        } else {
            return try await chunked(fileURL: fileURL, filename: filename, type: type,
                                     parent: parent, size: size, progress: progress)
        }
    }

    // MARK: - single multipart POST

    private static func singleShot(fileURL: URL, filename: String, type: String?, parent: String?,
                                   progress: @escaping @MainActor (Double) -> Void) async throws -> FileItem {
        let boundary = "Boundary-\(UUID().uuidString)"
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(value)\r\n".data(using: .utf8)!)
        }
        if let parent { field("parent", parent) }
        if let type { field("type", type) }
        // the file part
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: application/octet-stream\r\n\r\n".data(using: .utf8)!)
        body.append(try Data(contentsOf: fileURL))
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        var req = URLRequest(url: API.shared.baseURLSync.appendingPathComponent("/api/files"))
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.httpBody = body

        await progress(0.05)
        let (data, resp) = try await sharedSession.data(for: req)
        try throwIfBad(resp, data)
        await progress(1.0)
        return try JSONDecoder().decode(FileItem.self, from: data)
    }

    // MARK: - chunked upload

    private struct InitResp: Decodable { let uploadId: String; let chunkSize: Int; let maxParallel: Int }

    private static func chunked(fileURL: URL, filename: String, type: String?, parent: String?,
                                size: Int, progress: @escaping @MainActor (Double) -> Void) async throws -> FileItem {
        // 1) init
        var body: [String: Any] = ["name": filename, "size": size]
        if let type { body["type"] = type }
        if let parent { body["parent"] = parent }
        var initReq = URLRequest(url: API.shared.baseURLSync.appendingPathComponent("/api/uploads/init"))
        initReq.httpMethod = "POST"
        initReq.setValue("application/json", forHTTPHeaderField: "Content-Type")
        initReq.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (initData, initResp) = try await sharedSession.data(for: initReq)
        try throwIfBad(initResp, initData)
        let info = try JSONDecoder().decode(InitResp.self, from: initData)

        // 2) PUT each chunk at its byte offset. We read+send sequentially (simple and
        // memory-light); the server accepts out-of-order/parallel but sequential is
        // plenty for a phone uplink and keeps the progress bar honest.
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        var offset = 0
        while offset < size {
            let len = min(info.chunkSize, size - offset)
            try handle.seek(toOffset: UInt64(offset))
            let chunk = handle.readData(ofLength: len)

            var url = URLComponents(url: API.shared.baseURLSync.appendingPathComponent("/api/uploads/\(info.uploadId)"),
                                    resolvingAgainstBaseURL: false)!
            url.queryItems = [URLQueryItem(name: "offset", value: String(offset))]
            var putReq = URLRequest(url: url.url!)
            putReq.httpMethod = "PUT"
            putReq.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            let (putData, putResp) = try await sharedSession.upload(for: putReq, from: chunk)
            try throwIfBad(putResp, putData)

            offset += len
            let frac = Double(offset) / Double(max(size, 1)) * 0.98
            await progress(frac)
        }

        // 3) complete
        var doneReq = URLRequest(url: API.shared.baseURLSync.appendingPathComponent("/api/uploads/\(info.uploadId)/complete"))
        doneReq.httpMethod = "POST"
        let (doneData, doneResp) = try await sharedSession.data(for: doneReq)
        try throwIfBad(doneResp, doneData)
        await progress(1.0)
        return try JSONDecoder().decode(FileItem.self, from: doneData)
    }

    // MARK: - shared session + helpers

    /// A session that shares the app-wide cookie store so uploads are authenticated.
    private static let sharedSession: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.httpCookieStorage = HTTPCookieStorage.shared
        cfg.httpShouldSetCookies = true
        cfg.timeoutIntervalForRequest = 120
        cfg.timeoutIntervalForResource = 3600
        return URLSession(configuration: cfg)
    }()

    private static func throwIfBad(_ resp: URLResponse, _ data: Data) throws {
        guard let http = resp as? HTTPURLResponse else {
            throw APIError(status: -1, message: "Bad response", needsReauth: false)
        }
        guard (200...299).contains(http.statusCode) else {
            var msg = "Upload failed (HTTP \(http.statusCode))"
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let e = obj["error"] as? String { msg = e }
            throw APIError(status: http.statusCode, message: msg,
                           needsReauth: http.statusCode == 401)
        }
    }
}
