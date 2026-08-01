import Foundation
import SwiftUI

/// State for the CONNECT system. Unlike Habit (local-first), Connect is inherently
/// SERVER-FIRST: a room only means anything because other people are in it, so there
/// is nothing useful to own offline. Rooms and chat are fetched, and chat is polled
/// while a room is open.
///
/// The live CALL is not driven from here — WebRTC exists on iOS only inside a web
/// view, so `ConnectCallView` hosts the already-working web client. This store owns
/// everything around it: the room list, joining by code, and the native chat.
@MainActor
final class ConnectStore: ObservableObject {
    @Published private(set) var rooms: [ConnectRoom] = []
    @Published var openRoom: ConnectRoom?
    @Published private(set) var messages: [ConnectMessage] = []
    @Published var loaded = false
    @Published var loadingRoom = false
    @Published var error: String?
    /// Set when a join fails, so the join sheet can show it inline rather than as a toast.
    @Published var joinError: String?
    @Published var replyingTo: ConnectMessage?

    /// The account id of the signed-in user, needed to recompute `mine` on reactions.
    var myAccountId: String?

    private var pollTask: Task<Void, Never>?
    private var lastMessageAt: Double = 0

    /// Emoji offered in the reaction picker — same set as the web client.
    static let reactionChoices = ["👍", "❤️", "😂", "🎉", "😮", "😢", "🔥", "👀"]

    // MARK: - rooms

    func loadRooms() async {
        do {
            rooms = try await API.shared.connectRooms()
            error = nil
            loaded = true
        } catch let e as APIError {
            error = e.message
            loaded = true
        } catch {
            self.error = error.localizedDescription
            loaded = true
        }
    }

    func createRoom(name: String, topic: String?) async -> ConnectRoom? {
        do {
            let room = try await API.shared.createConnectRoom(name: name, topic: topic)
            rooms.insert(room, at: 0)
            return room
        } catch let e as APIError {
            error = e.message
            return nil
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }

    /// Join by code. Returns the room on success; sets `joinError` and returns nil
    /// otherwise (bad code, locked room, already full).
    func join(code raw: String) async -> ConnectRoom? {
        guard let code = ConnectCode.normalize(raw) else {
            joinError = "A room code is 5 characters — letters and numbers."
            return nil
        }
        do {
            let room = try await API.shared.joinConnectRoom(code: code)
            joinError = nil
            if !rooms.contains(where: { $0.id == room.id }) { rooms.insert(room, at: 0) }
            return room
        } catch let e as APIError {
            joinError = e.message
            return nil
        } catch {
            joinError = error.localizedDescription
            return nil
        }
    }

    /// Open a room: fetch it fresh, load chat, and start polling.
    func open(_ room: ConnectRoom) async {
        openRoom = room
        messages = []
        lastMessageAt = 0
        loadingRoom = true
        defer { loadingRoom = false }
        do {
            let fresh = try await API.shared.connectRoom(room.id)
            openRoom = fresh
            if let i = rooms.firstIndex(where: { $0.id == fresh.id }) { rooms[i] = fresh }
            await loadMessages()
            startPolling()
        } catch let e as APIError {
            error = e.message
        } catch {
            self.error = error.localizedDescription
        }
    }

    func closeRoom() {
        stopPolling()
        openRoom = nil
        messages = []
        replyingTo = nil
        lastMessageAt = 0
    }

    func updateRoom(name: String, topic: String?, locked: Bool) async {
        guard let room = openRoom else { return }
        do {
            let updated = try await API.shared.updateConnectRoom(room.id, name: name, topic: topic, locked: locked)
            openRoom = updated
            if let i = rooms.firstIndex(where: { $0.id == updated.id }) { rooms[i] = updated }
        } catch let e as APIError { error = e.message }
        catch { self.error = error.localizedDescription }
    }

    /// Delete the room — this also erases its chat for everyone, by design.
    func deleteRoom() async {
        guard let room = openRoom else { return }
        do {
            try await API.shared.deleteConnectRoom(room.id)
            rooms.removeAll { $0.id == room.id }
            closeRoom()
        } catch let e as APIError { error = e.message }
        catch { self.error = error.localizedDescription }
    }

    func leaveRoom() async {
        guard let room = openRoom else { return }
        do {
            try await API.shared.leaveConnectRoom(room.id)
            rooms.removeAll { $0.id == room.id }
            closeRoom()
        } catch let e as APIError { error = e.message }
        catch { self.error = error.localizedDescription }
    }

    func removeMember(_ accountId: String) async {
        guard let room = openRoom else { return }
        do {
            try await API.shared.removeConnectMember(room: room.id, account: accountId)
            let fresh = try await API.shared.connectRoom(room.id)
            openRoom = fresh
        } catch let e as APIError { error = e.message }
        catch { self.error = error.localizedDescription }
    }

    // MARK: - chat

    func loadMessages() async {
        guard let room = openRoom else { return }
        do {
            let msgs = try await API.shared.connectMessages(room: room.id)
            messages = msgs.map(normalizeMine)
            lastMessageAt = messages.last?.created ?? 0
        } catch { /* a failed refresh keeps what we have */ }
    }

    func send(_ text: String) async {
        guard let room = openRoom else { return }
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        let reply = replyingTo?.id
        replyingTo = nil
        do {
            let msg = try await API.shared.sendConnectMessage(room: room.id, text: body, replyTo: reply)
            upsert(msg)
        } catch let e as APIError { error = e.message }
        catch { self.error = error.localizedDescription }
    }

    func edit(_ message: ConnectMessage, text: String) async {
        guard let room = openRoom else { return }
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, body != message.text else { return }
        do { upsert(try await API.shared.editConnectMessage(room: room.id, id: message.id, text: body)) }
        catch let e as APIError { error = e.message }
        catch { self.error = error.localizedDescription }
    }

    func delete(_ message: ConnectMessage) async {
        guard let room = openRoom else { return }
        do {
            try await API.shared.deleteConnectMessage(room: room.id, id: message.id)
            messages.removeAll { $0.id == message.id }
        } catch let e as APIError { error = e.message }
        catch { self.error = error.localizedDescription }
    }

    /// Add or take back one emoji on a message.
    func toggleReaction(_ message: ConnectMessage, emoji: String) async {
        guard let room = openRoom else { return }
        let mineAlready = message.reactions.first { $0.emoji == emoji }?.mine ?? false
        do {
            let updated = try await API.shared.reactConnectMessage(
                room: room.id, id: message.id, emoji: emoji, remove: mineAlready)
            upsert(updated)
        } catch let e as APIError { error = e.message }
        catch { self.error = error.localizedDescription }
    }

    // MARK: - polling
    //
    // The web client gets chat live over its SSE signaling stream while in the call.
    // Here the call runs inside a web view that owns its own stream, so the native
    // chat polls instead. 3s matches the web client's out-of-call cadence.

    private func startPolling() {
        stopPolling()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                if Task.isCancelled { return }
                await self?.pollOnce()
            }
        }
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func pollOnce() async {
        guard let room = openRoom else { return }
        do {
            // Ask only for what's new. Reactions and edits on OLD messages won't come
            // back from a `since` query, so refresh the whole window periodically too.
            let fresh = try await API.shared.connectMessages(room: room.id, since: lastMessageAt)
            for m in fresh { upsert(m) }
            if fresh.isEmpty { await refreshReactions() }
        } catch { /* transient; try again next tick */ }
    }

    /// Pull the full recent window so reactions/edits/deletions on older messages
    /// show up. Cheap (capped server-side) and only runs on an idle tick.
    private var refreshCounter = 0
    private func refreshReactions() async {
        refreshCounter += 1
        guard refreshCounter % 3 == 0 else { return }   // ~every 9s while idle
        guard let room = openRoom else { return }
        guard let msgs = try? await API.shared.connectMessages(room: room.id) else { return }
        messages = msgs.map(normalizeMine)
        lastMessageAt = messages.last?.created ?? lastMessageAt
    }

    // MARK: - helpers

    private func upsert(_ raw: ConnectMessage) {
        let m = normalizeMine(raw)
        if let i = messages.firstIndex(where: { $0.id == m.id }) { messages[i] = m }
        else { messages.append(m) }
        messages.sort { $0.created == $1.created ? $0.id < $1.id : $0.created < $1.created }
        if m.created > lastMessageAt { lastMessageAt = m.created }
    }

    /// A payload built for broadcast carries mine=false for everyone, so derive our
    /// own flags from the account id (the same rule the web client uses).
    private func normalizeMine(_ m: ConnectMessage) -> ConnectMessage {
        guard let me = myAccountId else { return m }
        var out = m
        out.mine = m.authorId == me
        out.reactions = m.reactions.map { r in
            var rr = r
            if let by = r.by { rr.mine = by.contains(me) }
            return rr
        }
        return out
    }

    // NB: no deinit here on purpose. Touching the @MainActor-isolated `pollTask` from
    // a non-isolated deinit is a Swift concurrency error, and it isn't needed: the
    // store is owned by AppShell for the whole session, and closeRoom() (called from
    // ConnectRoomView.onDisappear) already cancels the poll when a room closes.
}
