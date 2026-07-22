import Foundation

/// One row from `GET /api/files`. The server returns a FLAT array of every file and
/// folder in the account; the folder tree is reconstructed on-device from `parent`
/// (a nil parent means the vault root). Field names mirror the SQLite `files` table
/// as reshaped by the server's `rowToApi()`.
///
/// Decoding is hand-written because the server's JSON is loose in two ways: (1) many
/// keys are OMITTED entirely when nil/falsy (so everything optional must be
/// `decodeIfPresent`), and (2) booleans are inconsistent — `trashed`/`starred` are
/// real JSON booleans while flags copied straight off the row (like `locked`) come as
/// the integer 0/1. `flexBool` absorbs both so one odd field can't fail the list.
struct FileItem: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    /// "folder" or a media/doc kind: image | video | audio | document | model3d | …
    var type: String
    /// nil = vault root.
    var parent: String?
    var size: Int
    /// epoch milliseconds.
    var date: Double
    var trashed: Bool?
    var starred: Bool?

    // media metadata (present only when known)
    var dur: Double?
    var w: Int?
    var h: Int?
    var artist: String?
    var album: String?

    // server-supplied relative URLs
    var url: String?        // /api/files/{id}/raw  (blob-backed files)
    var coverUrl: String?
    var posterUrl: String?

    /// true when a content-backed document body exists (fetch via /content).
    var hasContent: Bool?
    var tags: [String]?
    var locked: Bool?
    var kv: Int?

    enum CodingKeys: String, CodingKey {
        case id, name, type, parent, size, date, trashed, starred
        case dur, w, h, artist, album, url, coverUrl, posterUrl
        case hasContent, tags, locked, kv
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        type = try c.decode(String.self, forKey: .type)
        parent = try c.decodeIfPresent(String.self, forKey: .parent)
        size = (try? c.decode(Int.self, forKey: .size)) ?? 0
        // date is epoch ms; accept a JSON number in Int or Double form.
        date = (try? c.decode(Double.self, forKey: .date)) ?? 0
        trashed = Self.flexBool(c, .trashed)
        starred = Self.flexBool(c, .starred)
        dur = try? c.decode(Double.self, forKey: .dur)
        w = try? c.decode(Int.self, forKey: .w)
        h = try? c.decode(Int.self, forKey: .h)
        artist = try? c.decode(String.self, forKey: .artist)
        album = try? c.decode(String.self, forKey: .album)
        url = try? c.decode(String.self, forKey: .url)
        coverUrl = try? c.decode(String.self, forKey: .coverUrl)
        posterUrl = try? c.decode(String.self, forKey: .posterUrl)
        hasContent = Self.flexBool(c, .hasContent)
        tags = try? c.decode([String].self, forKey: .tags)
        locked = Self.flexBool(c, .locked)
        kv = try? c.decode(Int.self, forKey: .kv)
    }

    /// Standard encode (only used if we ever re-serialize; the API never needs it).
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(type, forKey: .type)
        try c.encodeIfPresent(parent, forKey: .parent)
        try c.encode(size, forKey: .size)
        try c.encode(date, forKey: .date)
        try c.encodeIfPresent(trashed, forKey: .trashed)
        try c.encodeIfPresent(starred, forKey: .starred)
    }

    /// Decode a bool that might be a JSON bool, a 0/1 int, or absent.
    private static func flexBool(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> Bool? {
        if let b = try? c.decode(Bool.self, forKey: key) { return b }
        if let i = try? c.decode(Int.self, forKey: key) { return i != 0 }
        return nil
    }

    // ---- derived helpers ----

    var isFolder: Bool { type == "folder" }
    var isTrashed: Bool { trashed == true }
    var isStarred: Bool { starred == true }
    var isLocked: Bool { locked == true }

    var createdDate: Date { Date(timeIntervalSince1970: date / 1000.0) }

    /// Broad category the UI uses to pick a viewer / icon.
    enum Kind { case folder, image, video, audio, document, other }
    var kind: Kind {
        switch type {
        case "folder": return .folder
        case "image": return .image
        case "video": return .video
        case "audio": return .audio
        case "document", "code", "markdown", "text": return .document
        default:
            // fall back to extension sniffing for types the server labels generically
            let ext = (name as NSString).pathExtension.lowercased()
            if ["png","jpg","jpeg","gif","webp","bmp","heic","svg"].contains(ext) { return .image }
            if ["mp4","mov","m4v","webm","mkv","avi"].contains(ext) { return .video }
            if ["mp3","m4a","aac","wav","flac","ogg","opus"].contains(ext) { return .audio }
            if ["txt","md","json","js","ts","swift","py","html","css","csv","log","xml","yml","yaml"].contains(ext) { return .document }
            return .other
        }
    }
}

/// The authenticated account (`GET /api/me` / login response `account`). Only the
/// fields the vault UI actually shows are decoded; unknown keys are ignored.
struct Account: Codable, Hashable {
    let id: String
    let username: String
    var display: String?
    var quota_bytes: Int?
    var is_admin: Bool?
}

/// Login can complete in one step, or bounce to a TOTP code step.
enum LoginResult {
    case success(Account)
    case need2fa(ticket: String)
}
