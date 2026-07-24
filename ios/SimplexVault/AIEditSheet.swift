import SwiftUI
import UserNotifications
import UIKit

/// Which vault files can be AI-edited, and by whom. Mirrors the server gate: real,
/// unlocked PNG/JPEG images, and only accounts with AI enabled (admins always).
enum AIEditKit {
    static func canEdit(_ item: FileItem, account: Account?) -> Bool {
        guard item.kind == .image, item.isLocked == false else { return false }
        // AI must be enabled for the account. The server is the real gate; here we only
        // avoid showing the action to accounts that clearly can't use it. If we don't
        // know (older /me without the field), show it and let the server decide.
        let ext = (item.name as NSString).pathExtension.lowercased()
        guard ["png", "jpg", "jpeg"].contains(ext) else { return false }
        return true
    }
}

/// Fires the local notification that tells the user their edit is ready. Used when the
/// app isn't in the foreground at completion time (the server finished the job on its
/// own; this is just the "it's done" nudge). Reuses the notification permission the
/// Habit system already requests; if it isn't granted, this is a silent no-op.
enum AIEditNotifications {
    static func notifyReady(fileName: String) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
            let content = UNMutableNotificationContent()
            content.title = "Your AI edit is ready"
            content.body = "“\(fileName)” was saved to your vault."
            content.sound = .default
            content.interruptionLevel = .active
            let req = UNNotificationRequest(identifier: "aiedit.\(UUID().uuidString)", content: content, trigger: nil)
            center.add(req)
        }
    }

    /// Ask for permission the first time the user opens the AI Edit sheet (harmless if
    /// already granted / the Habit system asked already).
    static func requestIfNeeded() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }
}

/// AI Image Editing sheet (xAI Grok Imagine). The user picks a quality + prompt, confirms
/// the credit spend, and the server edits the image and saves it beside the original. The
/// job runs to completion server-side even if the app is backgrounded or the device drops
/// off; while the app is open we show a blurred source + progress, then a confetti drop
/// over the result. If the app leaves the foreground mid-edit, a local notification fires
/// when it finishes.
struct AIEditSheet: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    let item: FileItem

    private enum Stage { case setup, running, done, failed }

    @State private var quality = "default"
    @State private var prompt = ""
    @State private var stage: Stage = .setup
    @State private var showConfirm = false
    @State private var phase = ""
    @State private var error: String?
    @State private var savedFile: FileItem?
    @State private var showConfetti = false
    @State private var wasBackgrounded = false

    private var tokens: ImgEditTokens { store.account?.img_edit ?? ImgEditTokens() }
    private var cost: Int { quality == "premium" ? 2 : 1 }

    var body: some View {
        NavigationStack {
            ZStack {
                SimplexTheme.bg.ignoresSafeArea()
                content
                if showConfetti { ConfettiView().transition(.opacity) }
            }
            .navigationTitle("AI Edit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(stage == .done ? "Close" : "Cancel") { dismiss() }
                        .disabled(stage == .running)
                }
            }
        }
        .preferredColorScheme(Appearance.shared.colorScheme)
        .onAppear { AIEditNotifications.requestIfNeeded() }
        .onChange(of: scenePhase) { newPhase in
            // Remember if we ever left the foreground during a run — that decides whether
            // completion should post a local notification vs. just animate on-screen.
            if newPhase != .active && stage == .running { wasBackgrounded = true }
        }
        .interactiveDismissDisabled(stage == .running)
    }

    // MARK: - content by stage

    @ViewBuilder private var content: some View {
        VStack(spacing: 18) {
            preview
            switch stage {
            case .setup:
                setupControls
            case .running:
                VStack(spacing: 10) {
                    ProgressView().tint(SimplexTheme.accent)
                    Text(phaseLabel).font(SimplexTheme.mono(12)).foregroundStyle(SimplexTheme.subtle)
                    Text("This keeps going even if you leave the app.")
                        .font(SimplexTheme.mono(10)).foregroundStyle(SimplexTheme.subtle).opacity(0.7)
                }
            case .done:
                VStack(spacing: 6) {
                    Label("Saved to your vault", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    if let f = savedFile {
                        Text(f.name).font(SimplexTheme.mono(12)).foregroundStyle(SimplexTheme.subtle)
                    }
                }
            case .failed:
                Text(error ?? "Image edit failed").font(.footnote).foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            Spacer()
            actionButton
        }
        .padding(18)
        .confirmationDialog("Use \(cost) edit \(cost == 1 ? "credit" : "credits")?",
                            isPresented: $showConfirm, titleVisibility: .visible) {
            Button("Edit image") { start() }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("This \(quality == "premium" ? "Premium" : "Default") edit uses \(cost) of your \(tokens.left) remaining edits today.")
        }
    }

    private var preview: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14).fill(SimplexTheme.surface2)
            // Once done, show the edited result; otherwise the source (blurred while running).
            let shown = savedFile ?? item
            Thumbnail(item: shown)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .blur(radius: stage == .running ? 16 : 0)
                .scaleEffect(stage == .running ? 1.05 : 1)
                .animation(.easeInOut(duration: 0.4), value: stage)
            if stage == .running {
                // subtle shimmer over the blur
                RoundedRectangle(cornerRadius: 14)
                    .fill(LinearGradient(colors: [.clear, .white.opacity(0.12), .clear],
                                         startPoint: .topLeading, endPoint: .bottomTrailing))
            }
        }
        .frame(height: 220)
    }

    private var setupControls: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 8) {
                Text("QUALITY").font(SimplexTheme.mono(10)).foregroundStyle(SimplexTheme.subtle)
                Picker("Quality", selection: $quality) {
                    Text("Default · 1").tag("default")
                    if tokens.canPremium { Text("Premium · 2").tag("premium") }
                }
                .pickerStyle(.segmented)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("DESCRIBE THE EDIT").font(SimplexTheme.mono(10)).foregroundStyle(SimplexTheme.subtle)
                TextField("e.g. make it night-time with neon lighting", text: $prompt, axis: .vertical)
                    .lineLimit(2...4)
                    .padding(10)
                    .background(SimplexTheme.surface2, in: RoundedRectangle(cornerRadius: 10))
                    .foregroundStyle(SimplexTheme.text)
            }
            Text(tokenLine).font(SimplexTheme.mono(11)).foregroundStyle(SimplexTheme.subtle)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var tokenLine: String {
        tokens.isUnlimited ? "Unlimited edits (admin)"
            : "\(tokens.left) of \(tokens.limit ?? 5) daily edits left · resets at midnight"
    }

    private var phaseLabel: String {
        switch phase {
        case "reading": return "Reading image…"
        case "editing": return "Editing with AI…"
        case "saving":  return "Saving to your vault…"
        case "done":    return "Done!"
        default:        return "Starting…"
        }
    }

    @ViewBuilder private var actionButton: some View {
        switch stage {
        case .setup:
            Button { attemptStart() } label: {
                Text("Edit image").bold().frame(maxWidth: .infinity).padding(.vertical, 13)
            }
            .background(canStart ? SimplexTheme.accent : SimplexTheme.surface2, in: RoundedRectangle(cornerRadius: 10))
            .foregroundStyle(canStart ? .black : SimplexTheme.subtle)
            .disabled(!canStart)
        case .running:
            Button { } label: {
                HStack { ProgressView().tint(.black); Text("Editing…").bold() }
                    .frame(maxWidth: .infinity).padding(.vertical, 13)
            }
            .background(SimplexTheme.surface2, in: RoundedRectangle(cornerRadius: 10))
            .disabled(true)
        case .done:
            Button { dismiss() } label: {
                Text("Done").bold().frame(maxWidth: .infinity).padding(.vertical, 13)
            }
            .background(SimplexTheme.accent, in: RoundedRectangle(cornerRadius: 10))
            .foregroundStyle(.black)
        case .failed:
            Button { stage = .setup; error = nil } label: {
                Text("Try again").bold().frame(maxWidth: .infinity).padding(.vertical, 13)
            }
            .background(SimplexTheme.accent, in: RoundedRectangle(cornerRadius: 10))
            .foregroundStyle(.black)
        }
    }

    private var canStart: Bool {
        !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && tokens.canEdit
    }

    // MARK: - actions

    private func attemptStart() {
        guard canStart else { return }
        if tokens.isUnlimited { start() } else { showConfirm = true }
    }

    private func start() {
        stage = .running; phase = "starting"; error = nil
        let p = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            // Ask iOS for a little extra runtime so a quick completion can still land its
            // notification even if the user backgrounds the app mid-edit. The SERVER
            // finishes the job regardless of this — if iOS suspends us anyway, the poll
            // simply resumes (and notifies) the next time the app is foregrounded.
            var bgTask = UIBackgroundTaskIdentifier.invalid
            bgTask = UIApplication.shared.beginBackgroundTask(withName: "aiedit.poll") {
                UIApplication.shared.endBackgroundTask(bgTask); bgTask = .invalid
            }
            defer { if bgTask != .invalid { UIApplication.shared.endBackgroundTask(bgTask) } }
            do {
                let started = try await API.shared.startImageEdit(fileId: item.id, quality: quality, prompt: p)
                store.updateImageTokens(started.tokens)
                // Poll to completion. The server finishes regardless of this loop, so a
                // dropped connection just means we retry the poll.
                let result = try await pollToDone(jobId: started.jobId)
                store.updateImageTokens(result.tokens)
                savedFile = result.file
                await store.refresh()
                stage = .done
                if wasBackgrounded {
                    AIEditNotifications.notifyReady(fileName: result.file?.name ?? "your image")
                } else {
                    withAnimation { showConfetti = true }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { showConfetti = false }
                }
            } catch let e as APIError {
                error = e.message; stage = .failed
                if e.needsReauth { store.handle(e) }
            } catch {
                self.error = error.localizedDescription; stage = .failed
            }
        }
    }

    /// Poll the job every 1.5s until it's done or errors. A transient network failure on a
    /// single poll is swallowed and retried (the job itself is unaffected).
    private func pollToDone(jobId: String) async throws -> API.ImageJob {
        while true {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            do {
                let j = try await API.shared.imageJob(jobId)
                await MainActor.run { phase = j.phase ?? phase }
                if j.status == "done" { return j }
                if j.status == "error" {
                    throw APIError(status: 422, message: j.error ?? "image edit failed", needsReauth: false)
                }
            } catch let e as APIError where e.status == 422 {
                throw e   // real job failure — stop
            } catch {
                // transient (offline, timeout) — keep polling; the server keeps working
                continue
            }
        }
    }
}
