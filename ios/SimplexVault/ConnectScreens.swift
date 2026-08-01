import SwiftUI

/// The CONNECT system's screens: the room list, joining by code, the room itself
/// (chat + a button into the call), and the room settings.
///
/// Everything here is native SwiftUI. The one exception is the live call, which
/// runs in `ConnectCallView` — see that file for why.

// MARK: - room list

struct ConnectRoomsView: View {
    @EnvironmentObject var connect: ConnectStore
    @EnvironmentObject var store: Store
    @State private var showNew = false
    @State private var showJoin = false

    var body: some View {
        Group {
            if !connect.loaded {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if connect.rooms.isEmpty {
                emptyState
            } else {
                list
            }
        }
        .background(SimplexTheme.bg.ignoresSafeArea())
        .navigationTitle("Connect")
        .toolbar {
            ToolbarItemGroup(placement: .navigationBarTrailing) {
                Button { showJoin = true } label: { Image(systemName: "link") }
                    .accessibilityLabel("Join by code")
                Button { showNew = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New room")
            }
        }
        .sheet(isPresented: $showNew) { ConnectNewRoomSheet().environmentObject(connect) }
        .sheet(isPresented: $showJoin) { ConnectJoinSheet().environmentObject(connect) }
        .task { if !connect.loaded { await connect.loadRooms() } }
        .refreshable { await connect.loadRooms() }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                ForEach(connect.rooms) { room in
                    NavigationLink { ConnectRoomView(room: room) } label: {
                        ConnectRoomCard(room: room)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(16)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "video.bubble")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(SimplexTheme.accent.opacity(0.7))
            Text("No rooms yet").font(.headline)
            Text("Create a room and you'll get a 5-character code. Anyone you give the code to can join the call.")
                .font(.footnote)
                .foregroundStyle(SimplexTheme.subtle)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 36)
            HStack(spacing: 10) {
                Button("Create a room") { showNew = true }.buttonStyle(.borderedProminent)
                Button("Join by code") { showJoin = true }.buttonStyle(.bordered)
            }
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// One room in the list: name, who's live, and the code.
struct ConnectRoomCard: View {
    let room: ConnectRoom

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(room.name).font(.headline).foregroundStyle(SimplexTheme.text)
                Spacer()
                if room.isLive {
                    HStack(spacing: 5) {
                        Circle().fill(SimplexTheme.accent).frame(width: 6, height: 6)
                        Text("\(room.liveCount) in call").font(.caption2.weight(.semibold))
                    }
                    .foregroundStyle(SimplexTheme.accent)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(SimplexTheme.accent.opacity(0.15), in: Capsule())
                }
            }
            if let topic = room.topic, !topic.isEmpty {
                Text(topic).font(.footnote).foregroundStyle(SimplexTheme.subtle).lineLimit(2)
            }
            HStack {
                ConnectCodeChip(code: room.code)
                Spacer()
                Text("\(room.memberCount) \(room.memberCount == 1 ? "person" : "people")")
                    .font(.caption2).foregroundStyle(SimplexTheme.subtle)
            }
        }
        .padding(14)
        .background(SimplexTheme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(SimplexTheme.line, lineWidth: 1))
    }
}

/// The room code, monospaced and letter-spaced so it's easy to read aloud. Tapping
/// copies it — sharing the code is the whole access model.
struct ConnectCodeChip: View {
    let code: String
    var large = false
    @State private var copied = false

    var body: some View {
        Button {
            UIPasteboard.general.string = code
            withAnimation { copied = true }
            Task {
                try? await Task.sleep(nanoseconds: 1_400_000_000)
                withAnimation { copied = false }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.caption2)
                Text(code)
                    .font(.system(size: large ? 16 : 13, weight: .semibold, design: .monospaced))
                    .tracking(2.5)
            }
            .foregroundStyle(SimplexTheme.accent)
            .padding(.horizontal, large ? 12 : 9)
            .padding(.vertical, large ? 7 : 5)
            .background(SimplexTheme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Room code \(code.map(String.init).joined(separator: " ")). Tap to copy.")
    }
}

// MARK: - create

struct ConnectNewRoomSheet: View {
    @EnvironmentObject var connect: ConnectStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var topic = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Room name", text: $name)
                    TextField("Topic (optional)", text: $topic)
                } footer: {
                    Text("You'll get a 5-character code to share. Only people with the code can join.")
                }
            }
            .navigationTitle("New room")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        busy = true
                        Task {
                            _ = await connect.createRoom(
                                name: name.trimmingCharacters(in: .whitespaces),
                                topic: topic.isEmpty ? nil : topic)
                            busy = false
                            dismiss()
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                }
            }
        }
    }
}

// MARK: - join by code

struct ConnectJoinSheet: View {
    @EnvironmentObject var connect: ConnectStore
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var busy = false
    @FocusState private var focused: Bool

    private var ready: Bool { ConnectCode.isComplete(code) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                Text("Enter the 5-character code someone shared with you.")
                    .font(.footnote)
                    .foregroundStyle(SimplexTheme.subtle)
                    .multilineTextAlignment(.center)
                    .padding(.top, 8)

                TextField("ABC23", text: $code)
                    .font(.system(size: 34, weight: .bold, design: .monospaced))
                    .tracking(10)
                    .multilineTextAlignment(.center)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .focused($focused)
                    // keep the field valid as they type: uppercase, code alphabet only
                    .onChange(of: code) { newValue in
                        let clean = ConnectCode.sanitizeInput(newValue)
                        if clean != newValue { code = clean }
                        if connect.joinError != nil { connect.joinError = nil }
                    }
                    .padding(.vertical, 14)
                    .frame(maxWidth: .infinity)
                    .background(SimplexTheme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                if let err = connect.joinError {
                    Text(err).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
                }

                Button {
                    busy = true
                    Task {
                        let room = await connect.join(code: code)
                        busy = false
                        if room != nil { dismiss() }
                    }
                } label: {
                    if busy { ProgressView().frame(maxWidth: .infinity) }
                    else { Text("Join room").frame(maxWidth: .infinity) }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!ready || busy)

                Spacer()
            }
            .padding(20)
            .background(SimplexTheme.bg.ignoresSafeArea())
            .navigationTitle("Join a room")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .onAppear { focused = true }
        }
    }
}

// MARK: - the room (chat + entry to the call)

struct ConnectRoomView: View {
    let room: ConnectRoom
    @EnvironmentObject var connect: ConnectStore
    @State private var draft = ""
    @State private var showCall = false
    @State private var showSettings = false
    @State private var editing: ConnectMessage?
    @State private var editText = ""
    @State private var reactingTo: ConnectMessage?

    private var current: ConnectRoom { connect.openRoom ?? room }

    var body: some View {
        VStack(spacing: 0) {
            callBanner
            Divider().overlay(SimplexTheme.line)
            messagesList
            if let reply = connect.replyingTo { replyBar(reply) }
            composer
        }
        .background(SimplexTheme.bg.ignoresSafeArea())
        .navigationTitle(current.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { showSettings = true } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .task { await connect.open(room) }
        .onDisappear { connect.closeRoom() }
        // Sheets/covers are presented in their own environment, so the store is passed
        // explicitly rather than relying on inheritance across the presentation.
        .fullScreenCover(isPresented: $showCall) { ConnectCallView(room: current) }
        .sheet(isPresented: $showSettings) { ConnectRoomSettingsSheet().environmentObject(connect) }
        .sheet(item: $reactingTo) { msg in ConnectReactionPicker(message: msg).environmentObject(connect) }
        .alert("Edit message", isPresented: Binding(
            get: { editing != nil }, set: { if !$0 { editing = nil } })) {
            TextField("Message", text: $editText)
            Button("Cancel", role: .cancel) { editing = nil }
            Button("Save") {
                if let m = editing { Task { await connect.edit(m, text: editText) } }
                editing = nil
            }
        }
    }

    /// The "join the call" strip — the entry point into the WebRTC call.
    private var callBanner: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(current.liveSummary).font(.subheadline.weight(.medium))
                Text("End-to-end encrypted · your video never touches the server")
                    .font(.caption2).foregroundStyle(SimplexTheme.subtle)
            }
            Spacer()
            ConnectCodeChip(code: current.code)
            Button { showCall = true } label: {
                Label("Join", systemImage: "video.fill").font(.subheadline.weight(.semibold))
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(SimplexTheme.surface)
    }

    private var messagesList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if connect.messages.isEmpty && !connect.loadingRoom {
                        Text("No messages yet. Say hello.")
                            .font(.footnote).foregroundStyle(SimplexTheme.subtle)
                            .frame(maxWidth: .infinity).padding(.top, 40)
                    }
                    ForEach(connect.messages) { msg in
                        ConnectMessageRow(
                            message: msg,
                            replyTarget: msg.replyTo.flatMap { id in connect.messages.first { $0.id == id } },
                            canManage: current.canManage,
                            onReply: { connect.replyingTo = msg },
                            onReact: { reactingTo = msg },
                            onEdit: { editText = msg.text; editing = msg },
                            onDelete: { Task { await connect.delete(msg) } },
                            onToggleReaction: { emoji in Task { await connect.toggleReaction(msg, emoji: emoji) } }
                        )
                        .id(msg.id)
                    }
                }
                .padding(14)
            }
            .onChange(of: connect.messages.count) { _ in
                if let last = connect.messages.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
    }

    private func replyBar(_ reply: ConnectMessage) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "arrowshape.turn.up.left").font(.caption2)
            Text("Replying to \(reply.authorName)").font(.caption)
            Text(reply.text).font(.caption).foregroundStyle(SimplexTheme.subtle).lineLimit(1)
            Spacer()
            Button { connect.replyingTo = nil } label: { Image(systemName: "xmark").font(.caption2) }
                .buttonStyle(.plain)
        }
        .foregroundStyle(SimplexTheme.subtle)
        .padding(.horizontal, 14).padding(.vertical, 7)
        .background(SimplexTheme.accent.opacity(0.08))
    }

    private var composer: some View {
        HStack(spacing: 10) {
            TextField("Message the room…", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(SimplexTheme.surface2, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            Button {
                let text = draft
                draft = ""
                Task { await connect.send(text) }
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 28))
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(SimplexTheme.surface)
    }
}

// MARK: - one message

struct ConnectMessageRow: View {
    let message: ConnectMessage
    let replyTarget: ConnectMessage?
    let canManage: Bool
    let onReply: () -> Void
    let onReact: () -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void
    let onToggleReaction: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(message.authorName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(message.mine ? SimplexTheme.accent : SimplexTheme.text)
                Text(message.createdDate, style: .time)
                    .font(.caption2).foregroundStyle(SimplexTheme.subtle)
                if message.wasEdited {
                    Text("(edited)").font(.caption2).foregroundStyle(SimplexTheme.subtle)
                }
            }
            if let reply = replyTarget {
                HStack(spacing: 4) {
                    Image(systemName: "arrowshape.turn.up.left").font(.system(size: 9))
                    Text(reply.authorName).font(.caption2.weight(.semibold))
                    Text(reply.text).font(.caption2).lineLimit(1)
                }
                .foregroundStyle(SimplexTheme.subtle)
                .padding(.leading, 6)
                .overlay(alignment: .leading) {
                    Rectangle().fill(SimplexTheme.accent.opacity(0.5)).frame(width: 2)
                }
            }
            Text(message.text).font(.subheadline).foregroundStyle(SimplexTheme.text)
                .textSelection(.enabled)
            if !message.reactions.isEmpty {
                HStack(spacing: 5) {
                    ForEach(message.reactions) { r in
                        Button { onToggleReaction(r.emoji) } label: {
                            HStack(spacing: 3) {
                                Text(r.emoji).font(.caption2)
                                Text("\(r.count)").font(.caption2.weight(.semibold))
                            }
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(r.mine ? SimplexTheme.accent.opacity(0.18) : SimplexTheme.surface2,
                                        in: Capsule())
                            .overlay(Capsule().stroke(r.mine ? SimplexTheme.accent.opacity(0.5) : .clear, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .contextMenu {
            Button { onReact() } label: { Label("React", systemImage: "face.smiling") }
            Button { onReply() } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") }
            if message.mine {
                Button { onEdit() } label: { Label("Edit", systemImage: "pencil") }
            }
            if message.mine || canManage {
                Button(role: .destructive) { onDelete() } label: { Label("Delete", systemImage: "trash") }
            }
        }
    }
}

// MARK: - reaction picker

struct ConnectReactionPicker: View {
    let message: ConnectMessage
    @EnvironmentObject var connect: ConnectStore
    @Environment(\.dismiss) private var dismiss

    private let columns = [GridItem(.adaptive(minimum: 60))]

    var body: some View {
        NavigationStack {
            LazyVGrid(columns: columns, spacing: 14) {
                ForEach(ConnectStore.reactionChoices, id: \.self) { emoji in
                    Button {
                        Task { await connect.toggleReaction(message, emoji: emoji) }
                        dismiss()
                    } label: {
                        Text(emoji).font(.system(size: 32))
                            .frame(width: 56, height: 56)
                            .background(SimplexTheme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(20)
            .frame(maxHeight: .infinity, alignment: .top)
            .background(SimplexTheme.bg.ignoresSafeArea())
            .navigationTitle("React")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.height(260)])
    }
}

// MARK: - room settings

struct ConnectRoomSettingsSheet: View {
    @EnvironmentObject var connect: ConnectStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var topic = ""
    @State private var locked = false
    @State private var confirmDelete = false
    @State private var confirmLeave = false

    private var room: ConnectRoom? { connect.openRoom }

    var body: some View {
        NavigationStack {
            Form {
                if let room {
                    Section("Code") {
                        HStack {
                            ConnectCodeChip(code: room.code, large: true)
                            Spacer()
                            ShareLink(item: "Join my Simplex room \"\(room.name)\" with code \(room.code)") {
                                Label("Share", systemImage: "square.and.arrow.up")
                            }
                        }
                    }
                    if room.canManage {
                        Section("Room") {
                            TextField("Name", text: $name)
                            TextField("Topic", text: $topic)
                            Toggle("Locked", isOn: $locked)
                        } footer: {
                            Text("Locking stops the code from letting new people in.")
                        }
                    }
                    Section("People (\(room.members.count))") {
                        ForEach(room.members) { m in
                            HStack {
                                Text(m.name)
                                if m.isOwner {
                                    Text("owner").font(.caption2).foregroundStyle(SimplexTheme.subtle)
                                }
                                Spacer()
                                if room.canManage && !m.isOwner {
                                    Button("Remove", role: .destructive) {
                                        Task { await connect.removeMember(m.id) }
                                    }
                                    .font(.caption)
                                }
                            }
                        }
                    }
                    Section {
                        if room.isOwner {
                            Button("Delete room", role: .destructive) { confirmDelete = true }
                        } else {
                            Button("Leave room", role: .destructive) { confirmLeave = true }
                        }
                    } footer: {
                        Text(room.isOwner
                             ? "Deleting erases the room's chat and reactions for everyone."
                             : "You'll need the code again to come back.")
                    }
                }
            }
            .navigationTitle("Room settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                if room?.canManage == true {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            Task {
                                await connect.updateRoom(name: name, topic: topic.isEmpty ? nil : topic, locked: locked)
                                dismiss()
                            }
                        }
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .onAppear {
                name = room?.name ?? ""
                topic = room?.topic ?? ""
                locked = room?.locked ?? false
            }
            .confirmationDialog("Delete this room?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete room", role: .destructive) {
                    Task { await connect.deleteRoom(); dismiss() }
                }
            } message: {
                Text("The room and its entire chat history will be gone for everyone. This cannot be undone.")
            }
            .confirmationDialog("Leave this room?", isPresented: $confirmLeave, titleVisibility: .visible) {
                Button("Leave room", role: .destructive) {
                    Task { await connect.leaveRoom(); dismiss() }
                }
            }
        }
    }
}
