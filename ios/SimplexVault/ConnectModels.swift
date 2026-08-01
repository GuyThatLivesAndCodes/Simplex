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
    let created: Double
    var updated: Double
    var members: [ConnectMember]
    var memberCount: Int
    var liveCount: Int
    var live: [ConnectLivePeer]
    var maxPeers: Int?

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
    let kind: String
    let replyTo: String?
    var edited: Double?
    let created: Double
    var mine: Bool
    var reactions: [ConnectReaction]

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
