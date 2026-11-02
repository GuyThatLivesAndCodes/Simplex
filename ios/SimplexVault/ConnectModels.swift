import Foundation

/// Models for the CONNECT system — private rooms with live calls and chat.
/// These mirror the JSON the server returns from /api/connect/* (see server.js).
/// A room is reached ONLY by its 5-character code; nothing here can discover a
/// room the account has not joined.

// MARK: - room

struct ConnectRoom: Identifiable, Codable, Equatable {
    let id: String
    let code: String
    var name: String
    var topic: String?
    let ownerId: String
    let ownerName: String
    var isOwner: Bool
    var canManage: Bool
    var locked: Bool
    /// A temporary room is deleted (with its chat and files) once everyone leaves
    /// the call. The owner can pin it open by turning this on.
    var permanent: Bool = false
    let created: Double
    var updated: Double
    // Tolerant defaults: the room list and the single-room payload don't carry
    // identical field sets, and a missing key must never fail the decode.
    var members: [ConnectMember] = []
    var memberCount: Int = 0
    var liveCount: Int = 0
    var live: [ConnectLivePeer] = []
    var maxPeers: Int?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        code = try c.decodeIfPresent(String.self, forKey: .code) ?? ""
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "Room"
        topic = try c.decodeIfPresent(String.self, forKey: .topic)
        ownerId = try c.decodeIfPresent(String.self, forKey: .ownerId) ?? ""
        ownerName = try c.decodeIfPresent(String.self, forKey: .ownerName) ?? ""
        isOwner = try c.decodeIfPresent(Bool.self, forKey: .isOwner) ?? false
        canManage = try c.decodeIfPresent(Bool.self, forKey: .canManage) ?? false
        locked = try c.decodeIfPresent(Bool.self, forKey: .locked) ?? false
        permanent = try c.decodeIfPresent(Bool.self, forKey: .permanent) ?? false
        created = try c.decodeIfPresent(Double.self, forKey: .created) ?? 0
        updated = try c.decodeIfPresent(Double.self, forKey: .updated) ?? 0
        members = try c.decodeIfPresent([ConnectMember].self, forKey: .members) ?? []
        memberCount = try c.decodeIfPresent(Int.self, forKey: .memberCount) ?? members.count
        liveCount = try c.decodeIfPresent(Int.self, forKey: .liveCount) ?? 0
        live = try c.decodeIfPresent([ConnectLivePeer].self, forKey: .live) ?? []
        maxPeers = try c.decodeIfPresent(Int.self, forKey: .maxPeers)
    }

    /// The code split for display, so it can be shown letter-spaced and read aloud.
    var codeCharacters: [String] { code.map { String($0) } }

    /// Someone is on the call right now.
    var isLive: Bool { liveCount > 0 }

    var liveSummary: String {
        guard liveCount > 0 else { return "Nobody in the call" }
        let names = live.prefix(3).map(\.name).joined(separator: ", ")
        if liveCount <= 3 { return "\(names) in the call" }
        return "\(names) +\(liveCount - 3) in the call"
    }
}

struct ConnectMember: Identifiable, Codable, Equatable {
    let id: String
    let name: String
    let role: String
    let joined: Double

    var isOwner: Bool { role == "owner" }
}

struct ConnectLivePeer: Identifiable, Codable, Equatable {
    let id: String
    let name: String
}

// MARK: - chat

struct ConnectMessage: Identifiable, Codable, Equatable {
    let id: String
    let roomId: String
    let authorId: String
    let authorName: String
    var text: String
    // Defaulted below in init(from:) — a broadcast payload omits/zeroes some of
    // these, and a missing key must never fail the whole decode.
    var kind: String = "chat"
    var replyTo: String?
    var edited: Double?
    let created: Double
    var mine: Bool = false
    var reactions: [ConnectReaction] = []
    /// Files attached to this message (only present when kind == "file").
    var files: [ConnectFile]? = nil

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        roomId = try c.decodeIfPresent(String.self, forKey: .roomId) ?? ""
        authorId = try c.decode(String.self, forKey: .authorId)
        authorName = try c.decodeIfPresent(String.self, forKey: .authorName) ?? "Someone"
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "chat"
        replyTo = try c.decodeIfPresent(String.self, forKey: .replyTo)
        edited = try c.decodeIfPresent(Double.self, forKey: .edited)
        created = try c.decodeIfPresent(Double.self, forKey: .created) ?? 0
        mine = try c.decodeIfPresent(Bool.self, forKey: .mine) ?? false
        reactions = try c.decodeIfPresent([ConnectReaction].self, forKey: .reactions) ?? []
        files = try c.decodeIfPresent([ConnectFile].self, forKey: .files)
    }

    var createdDate: Date { Date(timeIntervalSince1970: created / 1000) }
    var wasEdited: Bool { edited != nil }
}

/// One emoji grouped across everyone who used it on a message.
struct ConnectReaction: Codable, Equatable, Identifiable {
    let emoji: String
    var count: Int
    var mine: Bool
    var names: [String]
    /// Every reactor's account id — lets a client recompute `mine` from a broadcast
    /// payload (which is written once for all recipients and so carries mine=false).
    var by: [String]?

    var id: String { emoji }
    var tooltip: String { names.joined(separator: ", ") }
}

// MARK: - attachments

/// A file shared into a room's chat.
///
/// `source` says where the bytes came from, and it matters: a "device" upload
/// exists ONLY on the server for this room, so it is destroyed when the room is —
/// `temporary` surfaces that so the UI can warn. A "vault" file was COPIED out of
/// the sender's vault, so their original is never at risk.
struct ConnectFile: Identifiable, Codable, Equatable {
    let id: String
    let name: String
    let ext: String
    var mime: String?
    let size: Int
    /// "image" | "video" | "audio" | "document" | … (mirrors the vault's types)
    let kind: String
    var w: Int?
    var h: Int?
    /// "device" or "vault"
    let source: String
    let ownerId: String
    let ownerName: String
    let created: Double
    /// Server-relative path; resolve against the API base to fetch.
    let url: String
    /// True for device uploads — the ones that die with the room.
    var temporary: Bool = false

    var isImage: Bool { kind == "image" }
    var absoluteURL: URL { API.serverURL.appendingPathComponent(url.hasPrefix("/") ? String(url.dropFirst()) : url) }

    var sizeText: String {
        let units = ["B", "KB", "MB", "GB"]
        var v = Double(size), i = 0
        while v >= 1024, i < units.count - 1 { v /= 1024; i += 1 }
        return String(format: i == 0 ? "%.0f %@" : "%.1f %@", v, units[i])
    }
}

// MARK: - API response envelopes

struct ConnectRoomsResponse: Codable {
    let rooms: [ConnectRoom]
    let maxPeers: Int?
}
struct ConnectRoomResponse: Codable {
    let room: ConnectRoom
}
struct ConnectMessagesResponse: Codable {
    let messages: [ConnectMessage]
}
struct ConnectMessageResponse: Codable {
    let message: ConnectMessage
}

// MARK: - code helpers

enum ConnectCode {
    /// The server's alphabet: 32 unambiguous uppercase characters (no O/0/I/1).
    static let alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    static let length = 5

    /// Normalize what a person typed the same way the server does: upcase, drop any
    /// separators they added, and require exactly 5 characters of the alphabet.
    /// Returns nil when the input can't be a valid code.
    static func normalize(_ raw: String) -> String? {
        let cleaned = raw.uppercased().filter { $0.isLetter || $0.isNumber }
        guard cleaned.count == length else { return nil }
        guard cleaned.allSatisfy({ alphabet.contains($0) }) else { return nil }
        return cleaned
    }

    /// Live validation for the join field — true once the text could be submitted.
    static func isComplete(_ raw: String) -> Bool { normalize(raw) != nil }

    /// Filter keystrokes as they arrive so the field can never hold an invalid code.
    static func sanitizeInput(_ raw: String) -> String {
        String(raw.uppercased().filter { alphabet.contains($0) }.prefix(length))
    }
}
