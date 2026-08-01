import SwiftUI
import WebKit
import AVFoundation

/// The live CALL screen.
///
/// WHY THIS IS A WEB VIEW
/// ----------------------
/// The call is WebRTC, which is what makes it end-to-end encrypted (DTLS-SRTP keys
/// are negotiated directly between the two devices, so the Simplex server relays
/// only signaling and can never decrypt a frame). On iOS, WebRTC is available ONLY
/// inside WebKit — Apple ships no native WebRTC API, and adding one would mean
/// vendoring Google's ~80MB libwebrtc binary, which this project's "no
/// dependencies" rule rules out.
///
/// So the call runs the SAME client the web app uses, hosted here in a WKWebView,
/// wrapped in native chrome. Everything AROUND the call — the room list, joining by
/// code, chat, reactions, settings — is native SwiftUI (see ConnectScreens.swift).
///
/// The session cookie is copied into the web view's cookie store before the first
/// load so the page is already signed in and lands straight in the room.
struct ConnectCallView: View {
    let room: ConnectRoom
    @Environment(\.dismiss) private var dismiss
    @State private var permissionDenied = false
    @State private var loading = true

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            ConnectWebView(url: API.connectCallURL(room: room.id), loading: $loading)
                .ignoresSafeArea(edges: .bottom)

            if loading {
                VStack(spacing: 12) {
                    ProgressView().tint(.white)
                    Text("Connecting to \(room.name)…").font(.footnote).foregroundStyle(.white.opacity(0.8))
                }
            }

            VStack {
                HStack {
                    Button {
                        dismiss()
                    } label: {
                        Label("Leave", systemImage: "xmark")
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(.ultraThinMaterial, in: Capsule())
                    }
                    Spacer()
                    ConnectCodeChip(code: room.code)
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(.ultraThinMaterial, in: Capsule())
                }
                .padding(.horizontal, 14)
                .padding(.top, 8)
                Spacer()
            }
        }
        .task { await requestMediaPermissions() }
        .onDisappear { deactivateAudioSession() }
        .alert("Camera & microphone access", isPresented: $permissionDenied) {
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            }
            Button("Not now", role: .cancel) { }
        } message: {
            Text("Simplex needs your camera and microphone to join a call. You can turn them on in Settings.")
        }
    }

    /// Ask up-front so the web view doesn't hit a silent denial mid-negotiation.
    /// Camera is requested too (people usually enable it during the call).
    private func requestMediaPermissions() async {
        let mic = await AVCaptureDevice.requestAccess(for: .audio)
        _ = await AVCaptureDevice.requestAccess(for: .video)
        if !mic { permissionDenied = true }
        configureAudioSession()
    }

    /// Without this the call plays out of the EARPIECE (the default for a
    /// record-and-play session) and sounds broken to the user. `.videoChat` also
    /// enables the system's voice processing, and `allowBluetooth` lets AirPods work.
    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .videoChat,
                                    options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
            try session.setActive(true)
        } catch {
            // Not fatal: the call still runs, it may just route to the earpiece.
            print("[connect] audio session setup failed: \(error.localizedDescription)")
        }
    }

    /// Hand the audio session back when the call screen closes, so music and other
    /// apps resume normally.
    private func deactivateAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
}

/// A WKWebView configured for a WebRTC call: inline media, no user gesture required
/// for playback, and auto-granted capture permission (the user already approved at
/// the OS level in `requestMediaPermissions`, so a second in-page prompt is noise).
struct ConnectWebView: UIViewRepresentable {
    let url: URL
    @Binding var loading: Bool

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        // Required for a call: video must play inline (not fullscreen-takeover) and
        // must start without a tap, since we auto-join.
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []

        let web = WKWebView(frame: .zero, configuration: cfg)
        // capture the Binding value itself (not `self`, which is a struct) so the
        // closure can escape into the coordinator
        let binding = $loading
        context.coordinator.setLoading = { binding.wrappedValue = $0 }
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.isScrollEnabled = true
        web.scrollView.contentInsetAdjustmentBehavior = .never

        // Hand the web view our session cookie so the page loads already signed in.
        // Without this it would bounce to the login screen inside the call sheet.
        let store = web.configuration.websiteDataStore.httpCookieStore
        let cookies = HTTPCookieStorage.shared.cookies(for: API.serverURL) ?? []
        let group = DispatchGroup()
        for cookie in cookies { group.enter(); store.setCookie(cookie) { group.leave() } }
        group.notify(queue: .main) { web.load(URLRequest(url: url)) }
        return web
    }

    /// Refresh the coordinator's writer each update so it never holds a stale binding.
    func updateUIView(_ uiView: WKWebView, context: Context) {
        // capture the Binding value itself (not `self`, which is a struct) so the
        // closure can escape into the coordinator
        let binding = $loading
        context.coordinator.setLoading = { binding.wrappedValue = $0 }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        /// A closure rather than the Binding itself: `makeCoordinator()` runs once, so a
        /// stored Binding would go stale across SwiftUI updates. The closure is
        /// refreshed from `updateUIView` and always writes to the current state.
        var setLoading: (Bool) -> Void = { _ in }

        /// WebKit delivers these on the main thread, but hop explicitly so the
        /// @State write is main-actor-safe regardless.
        private func finishLoading() {
            DispatchQueue.main.async { [setLoading] in setLoading(false) }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finishLoading() }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finishLoading() }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finishLoading() }

        /// Auto-grant the in-page camera/mic prompt: the user already granted (or
        /// denied) at the OS level before this view appeared, so asking twice only
        /// adds friction. A denial at the OS level makes capture fail regardless.
        func webView(_ webView: WKWebView,
                     requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo,
                     type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            // Only ever for OUR server — never grant capture to some other origin.
            decisionHandler(origin.host == API.serverURL.host ? .grant : .deny)
        }
    }
}
