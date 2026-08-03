import SwiftUI
import UniformTypeIdentifiers   // .item, for the device file picker

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
    @State private var showEdit = false
    @State private var reactingTo: ConnectMessage?
    @State private var showAttachOptions = false
    @State private var showFileImporter = false
    @State private var showVaultPicker = false

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
        // Sharing a file: the device path is called out because those bytes live
        // only in this room and go when it does.
        .confirmationDialog("Share a file", isPresented: $showAttachOptions, titleVisibility: .visible) {
            Button("From this device") { showFileImporter = true }
            Button("From my Database") { showVaultPicker = true }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Files shared here are deleted when the room is deleted. A file from this device lives only in this room — sharing from your Database copies it, so your original stays safe in your vault.")
        }
        .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): Task { for u in urls { await connect.uploadFile(u) } }
            case .failure: break   // the user cancelled, or the picker failed — nothing to say
            }
        }
        .sheet(isPresented: $showVaultPicker) {
            ConnectVaultPicker { fileId in Task { await connect.shareVaultFile(fileId) } }
        }
        // `alert(item:)`-style presentation via a dedicated flag. An inline
        // Binding(get:set:) inside the ViewBuilder trips up type inference here.
        .alert("Edit message", isPresented: $showEdit) {
            TextField("Message", text: $editText)
            Button("Cancel", role: .cancel) { editing = nil }
            Button("Save") {
                if let m = editing {
                    let text = editText
                    Task { await connect.edit(m, text: text) }
                }
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
                            onEdit: { editText = msg.text; editing = msg; showEdit = true },
                            onDelete: { Task { await connect.delete(msg) } },
                            onToggleReaction: { emoji in Task { await connect.toggleReaction(msg, emoji: emoji) } }
                        )
                        .id(msg.id)
                    }
                    if let sending = connect.uploading {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Sending \(sending)…").font(.caption).foregroundStyle(SimplexTheme.subtle)
                        }
                        .padding(.top, 2)
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
            Button { showAttachOptions = true } label: {
                Image(systemName: "plus.circle").font(.system(size: 22))
                    .foregroundStyle(SimplexTheme.subtle)
            }
            .accessibilityLabel("Share a file")
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
            if !message.text.isEmpty {
                Text(message.text).font(.subheadline).foregroundStyle(SimplexTheme.text)
                    .textSelection(.enabled)
            }
            if let files = message.files, !files.isEmpty {
                ForEach(files) { ConnectFileView(file: $0) }
            }
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

// MARK: - one attachment

/// Renders a shared file: images preview inline, everything else is a tappable row.
/// A "temporary" chip marks device uploads — the ones that vanish with the room.
struct ConnectFileView: View {
    let file: ConnectFile
    @Environment(\.openURL) private var openURL

    var body: some View {
        Button { openURL(file.absoluteURL) } label: {
            VStack(alignment: .leading, spacing: 4) {
                if file.isImage {
                    AsyncImage(url: file.absoluteURL) { phase in
                        switch phase {
                        case .success(let img):
                            img.resizable().scaledToFill()
                        case .failure:
                            Image(systemName: "photo").font(.title2).foregroundStyle(SimplexTheme.subtle)
                                .frame(maxWidth: .infinity, minHeight: 120)
                        default:
                            ProgressView().frame(maxWidth: .infinity, minHeight: 120)
                        }
                    }
                    .frame(maxWidth: 260, maxHeight: 200)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                } else {
                    HStack(spacing: 9) {
                        Image(systemName: icon).font(.system(size: 17)).foregroundStyle(SimplexTheme.accent)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(file.name).font(.caption.weight(.semibold)).lineLimit(1)
                            Text(file.sizeText).font(.caption2).foregroundStyle(SimplexTheme.subtle)
                        }
                        Spacer(minLength: 4)
                        Image(systemName: "arrow.down.circle").font(.caption).foregroundStyle(SimplexTheme.subtle)
                    }
                    .padding(10)
                    .background(SimplexTheme.surface2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                HStack(spacing: 5) {
                    if file.isImage {
                        Text("\(file.name) · \(file.sizeText)").font(.caption2).foregroundStyle(SimplexTheme.subtle)
                    }
                    if file.temporary {
                        Text("TEMPORARY")
                            .font(.system(size: 8, weight: .bold)).tracking(0.4)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(SimplexTheme.accent.opacity(0.18), in: Capsule())
                            .foregroundStyle(SimplexTheme.accent)
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity, alignment: .leading)
        .help(file.temporary ? "Uploaded from a device — deleted when this room is deleted" : "")
    }

    private var icon: String {
        switch file.kind {
        case "video":    return "film"
        case "audio":    return "waveform"
        case "document": return "doc.text"
        case "model3d":  return "cube"
        default:         return "doc"
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

// MARK: - vault picker

/// Pick a file out of the signed-in account's own vault to share into the chat.
/// The server COPIES it, so the original is never at risk — the footer says so.
struct ConnectVaultPicker: View {
    let onPick: (String) -> Void
    // NB: no @EnvironmentObject here on purpose — this sheet is presented without
    // one being injected, and an unsatisfied @EnvironmentObject crashes at runtime.
    @Environment(\.dismiss) private var dismiss
    @State private var items: [FileItem] = []
    @State private var loading = true
    @State private var search = ""

    private var filtered: [FileItem] {
        // folders aren't shareable; trashed files shouldn't resurface here
        let base = items
            .filter { $0.type != "folder" && !($0.trashed ?? false) }
            .sorted { $0.date > $1.date }
        guard !search.isEmpty else { return base }
        return base.filter { $0.name.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if filtered.isEmpty {
                    Text(items.isEmpty ? "Nothing in your vault to share yet." : "No files match that search.")
                        .font(.footnote).foregroundStyle(SimplexTheme.subtle)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(filtered) { f in
                        Button {
                            onPick(f.id)
                            dismiss()
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: icon(for: f.type)).foregroundStyle(SimplexTheme.subtle)
                                Text(f.name).lineLimit(1)
                                Spacer()
                                Text(sizeText(f.size)).font(.caption2).foregroundStyle(SimplexTheme.subtle)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    .listStyle(.plain)
                }
            }
            .searchable(text: $search, prompt: "Search your vault")
            .navigationTitle("Share from Database")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .safeAreaInset(edge: .bottom) {
                Text("Sharing copies the file into this room — your original stays in your vault. The copy is deleted with the room.")
                    .font(.caption2).foregroundStyle(SimplexTheme.subtle)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20).padding(.vertical, 10)
                    .frame(maxWidth: .infinity)
                    .background(.ultraThinMaterial)
            }
            .task {
                items = (try? await API.shared.listFiles()) ?? []
                loading = false
            }
        }
    }

    private func icon(for type: String) -> String {
        switch type {
        case "image":    return "photo"
        case "video":    return "film"
        case "audio":    return "waveform"
        case "document": return "doc.text"
        default:         return "doc"
        }
    }
    private func sizeText(_ n: Int) -> String {
        let units = ["B", "KB", "MB", "GB"]
        var v = Double(n), i = 0
        while v >= 1024, i < units.count - 1 { v /= 1024; i += 1 }
        return String(format: i == 0 ? "%.0f %@" : "%.1f %@", v, units[i])
    }
}

// MARK: - room settings

struct ConnectRoomSettingsSheet: View {
    @EnvironmentObject var connect: ConnectStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var topic = ""
    @State private var locked = false
    @State private var permanent = false
    @State private var confirmDelete = false
    @State private var confirmLeave = false

    private var room: ConnectRoom? { connect.openRoom }

    var body: some View {
        NavigationStack {
            Form {
                if let room {
                    // NB: `Section(header: Text(…))`, not `Section("…")`. With a
                    // trailing `footer:` in the same Form the compiler resolves the
                    // string overload against the content closure and fails
                    // ("cannot convert String to () -> Content"). The explicit
                    // header: form is unambiguous, so all sections here use it.
                    Section(header: Text("Code")) {
                        HStack {
                            ConnectCodeChip(code: room.code, large: true)
                            Spacer()
                            ShareLink(item: "Join my Simplex room \"\(room.name)\" with code \(room.code)") {
                                Label("Share", systemImage: "square.and.arrow.up")
                            }
                        }
                    }
                    if room.canManage {
                        // header: AND footer: both as labelled arguments. Mixing a
                        // labelled header with a trailing `footer:` closure is the
                        // same overload ambiguity in a different shape.
                        Section(
                            header: Text("Room"),
                            footer: Text("Locking stops the code from letting new people in.")
                        ) {
                            TextField("Name", text: $name)
                            TextField("Topic", text: $topic)
                            Toggle("Locked", isOn: $locked)
                        }
                    }
                    if room.isOwner {
                        Section {
                            Toggle("Keep this room permanently", isOn: $permanent)
                        } footer: {
                            Text(permanent
                                 ? "This room stays put when everyone leaves."
                                 : "Temporary: once everyone leaves the call, this room, its chat and any files shared in it are deleted automatically.")
                        }
                    }
                    Section(header: Text("People (\(room.members.count))")) {
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
                                await connect.updateRoom(name: name, topic: topic.isEmpty ? nil : topic,
                                                         locked: locked,
                                                         permanent: room?.isOwner == true ? permanent : nil)
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
                permanent = room?.permanent ?? false
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
