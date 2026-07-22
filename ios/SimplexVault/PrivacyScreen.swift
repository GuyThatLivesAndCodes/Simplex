import SwiftUI
import LocalAuthentication

/// Hides vault content whenever the app isn't focused, and requires Face ID / passcode
/// to reveal it again on return. Applied to the root view.
///
/// - The cover appears the instant the app becomes inactive (app switcher snapshot,
///   incoming call, backgrounding) so the vault never shows in the multitasking card.
/// - On returning to active, if `faceIDLock` is on, the content stays covered behind a
///   lock prompt until biometric/passcode auth succeeds.
struct PrivacyScreen: ViewModifier {
    @ObservedObject private var appr = Appearance.shared
    @Environment(\.scenePhase) private var scenePhase

    @State private var covered = false      // opaque cover visible (any non-active phase)
    @State private var locked = false       // requires auth to reveal
    @State private var authenticating = false

    func body(content: Content) -> some View {
        content
            .overlay {
                if covered || locked {
                    coverView
                        .transition(.opacity)
                }
            }
            .onChange(of: scenePhase) { phase in
                switch phase {
                case .active:
                    covered = false
                    if locked { attemptUnlock() }
                case .inactive, .background:
                    // cover immediately; arm the lock so returning requires auth
                    covered = true
                    if appr.faceIDLock { locked = true }
                @unknown default:
                    covered = true
                }
            }
    }

    private var coverView: some View {
        ZStack {
            SimplexTheme.bg.ignoresSafeArea()
            // a soft branded cover — no vault content behind it
            VStack(spacing: 18) {
                SimplexMark()
                if locked {
                    Image(systemName: "lock.fill").font(.system(size: 30)).foregroundStyle(SimplexTheme.subtle)
                    if !authenticating {
                        Button {
                            attemptUnlock()
                        } label: {
                            Label("Unlock", systemImage: "faceid")
                                .font(.callout.bold())
                                .padding(.horizontal, 22).padding(.vertical, 11)
                                .background(SimplexTheme.accent, in: Capsule())
                                .foregroundStyle(.black)
                        }
                    } else {
                        ProgressView().tint(SimplexTheme.accent)
                    }
                }
            }
        }
    }

    private func attemptUnlock() {
        guard locked, !authenticating else { return }
        authenticating = true
        let ctx = LAContext()
        ctx.localizedFallbackTitle = "Enter Passcode"
        var err: NSError?
        // Prefer biometrics, but fall back to device passcode so a user without Face ID
        // (or after failed scans) can still get in.
        let policy: LAPolicy = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
            ? .deviceOwnerAuthenticationWithBiometrics
            : .deviceOwnerAuthentication
        // If the device has no auth configured at all, don't lock the user out.
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
            locked = false; authenticating = false; return
        }
        ctx.evaluatePolicy(policy, localizedReason: "Unlock your Simplex vault") { success, _ in
            DispatchQueue.main.async {
                authenticating = false
                if success { withAnimation { locked = false; covered = false } }
            }
        }
    }
}

/// The Terms of Service agreement sheet (app side). Loads the current terms, requires the
/// user to scroll to the end and tick acknowledgment, then reports accept/decline back.
struct TosSheet: View {
    @EnvironmentObject var store: Store
    let onResolve: (Bool) async -> Void

    @State private var text: String = ""
    @State private var loading = true
    @State private var scrolledEnd = false
    @State private var acked = false
    @State private var working = false

    var body: some View {
        NavigationStack {
            ZStack {
                SimplexTheme.bg.ignoresSafeArea()
                VStack(alignment: .leading, spacing: 14) {
                    Text("Before adding content to your vault, please read and agree to the terms below. This applies to every upload, whether from your phone or your computer.")
                        .font(.footnote).foregroundStyle(SimplexTheme.subtle)

                    if loading {
                        ProgressView().tint(SimplexTheme.accent).frame(maxWidth: .infinity).padding(30)
                    } else {
                        ScrollView {
                            VStack(spacing: 0) {
                                Text(text)
                                    .font(SimplexTheme.mono(11.5))
                                    .foregroundStyle(SimplexTheme.text)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .textSelection(.enabled)
                                // sentinel: when this scrolls into view, the terms were read to the end
                                Color.clear.frame(height: 1)
                                    .onAppear { scrolledEnd = true }
                            }
                        }
                        .background(SimplexTheme.surface, in: RoundedRectangle(cornerRadius: 10))
                    }

                    Toggle(isOn: $acked) {
                        Text("I have read and agree to the Terms of Service, and I understand I am responsible and liable for the content I upload.")
                            .font(.footnote).foregroundStyle(SimplexTheme.text)
                    }
                    .tint(SimplexTheme.accent)

                    Button {
                        working = true
                        Task { await onResolve(true) }
                    } label: {
                        HStack { if working { ProgressView().tint(.black) }; Text("I Agree").bold() }
                            .frame(maxWidth: .infinity).padding(.vertical, 13)
                    }
                    .background((scrolledEnd && acked) ? SimplexTheme.accent : SimplexTheme.surface2,
                                in: RoundedRectangle(cornerRadius: 10))
                    .foregroundStyle((scrolledEnd && acked) ? .black : SimplexTheme.subtle)
                    .disabled(!(scrolledEnd && acked) || working)
                }
                .padding(18)
            }
            .navigationTitle("Terms of Service")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Not now") { Task { await onResolve(false) } }.disabled(working)
                }
            }
            .interactiveDismissDisabled(working)
            .task {
                do { text = try await API.shared.fetchTos().text }
                catch { text = "Could not load the Terms of Service. Please try again." }
                loading = false
                // if the terms are short enough not to scroll, count as read
                if text.count < 400 { scrolledEnd = true }
            }
        }
        .preferredColorScheme(Appearance.shared.colorScheme)
    }
}
