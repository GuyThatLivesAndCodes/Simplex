import SwiftUI
import AVKit

/// A standard video player page with the FULL native control set — play/pause, the
/// scrubber, skip ±15s, playback speed, Picture-in-Picture, AirPlay, and the system
/// Fullscreen button. Uses `AVPlayerViewController` (not SwiftUI's `VideoPlayer`) because
/// it provides the complete transport UI and handles progressive HTTP streaming, so
/// playback starts as soon as enough has buffered instead of stalling.
struct VideoPage: View {
    let item: FileItem
    @State private var player: AVPlayer?
    @State private var timeObserver: Any?
    @State private var resumedShown = false
    /// Set when this account has a saved spot: playback holds until the user picks
    /// Continue or Start over (the same choice the web viewer offers).
    @State private var askResumeAt: Double?
    /// Set once the video has been watched to the end: the spot is forgotten and no
    /// further position is saved, so leaving the page can't write it back.
    @State private var finished = false
    @State private var endObserver: NSObjectProtocol?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let player {
                SystemVideoPlayer(player: player)
                    .ignoresSafeArea(edges: .bottom)
                if let at = askResumeAt {
                    ResumePrompt(seconds: at,
                                 onContinue: { begin(at: at) },
                                 onStartOver: {
                                     VideoProgress.clear(fileId: item.id)
                                     begin(at: 0)
                                 })
                }
                if resumedShown {
                    // brief "Resumed" note so the jump isn't mysterious
                    VStack {
                        Spacer()
                        Text("Resumed where you left off")
                            .font(SimplexTheme.mono(11))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(.black.opacity(0.55), in: Capsule())
                            .padding(.bottom, 90)
                    }
                    .transition(.opacity)
                }
            } else {
                ProgressView().tint(SimplexTheme.accent)
            }
        }
        .navigationTitle(item.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.black, for: .navigationBar)
        .toolbar {
            // let the user jump back to the start (and forget the bookmark)
            if VideoProgress.hasResume(for: item.id) {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        VideoProgress.clear(fileId: item.id)
                        player?.seek(to: .zero)
                    } label: { Image(systemName: "backward.end") }
                }
            }
        }
        .onAppear { start() }
        .onDisappear { stop() }
    }

    private func start() {
        guard player == nil, let url = API.shared.rawURL(item) else { return }
        let p = makeStreamingPlayer(url: url)

        player = p

        // If there's a saved spot, ASK before playing; otherwise just start.
        if let secs = VideoProgress.position(for: item.id) {
            askResumeAt = secs
        } else {
            p.play()
        }

        // auto-save the position every 5s during playback so an accidental close keeps
        // your place. Whatever position we report is what gets stored.
        let interval = CMTime(seconds: 5, preferredTimescale: 600)
        timeObserver = p.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [item] time in
            let secs = time.seconds
            let dur = p.currentItem?.duration.seconds ?? 0
            guard secs.isFinite, secs > 0 else { return }
            // the observer fires on the main queue, but that isn't statically known —
            // hop onto the MainActor explicitly for the @MainActor cache.
            Task { @MainActor in
                guard !finished else { return }
                VideoProgress.save(fileId: item.id, seconds: secs, duration: dur.isFinite ? dur : 0)
            }
        }

        // watched to the end = finished, so forget the spot and start over next time
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: p.currentItem, queue: .main
        ) { _ in
            Task { @MainActor in
                finished = true
                VideoProgress.clear(fileId: item.id)
            }
        }
    }

    /// Dismiss the prompt and start playing, optionally from the saved spot.
    private func begin(at seconds: Double) {
        askResumeAt = nil
        guard let p = player else { return }
        finished = false
        if seconds > 0 {
            p.seek(to: CMTime(seconds: seconds, preferredTimescale: 600))
            resumedShown = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { withAnimation { resumedShown = false } }
        }
        p.play()
    }

    private func stop() {
        // save the exact position on the way out, then tear down (unless the video
        // finished, in which case the spot is meant to stay cleared)
        if let p = player {
            let secs = p.currentTime().seconds
            let dur = p.currentItem?.duration.seconds ?? 0
            if !finished, secs.isFinite, secs > 0 {
                VideoProgress.save(fileId: item.id, seconds: secs, duration: dur.isFinite ? dur : 0)
            }
            if let obs = timeObserver { p.removeTimeObserver(obs); timeObserver = nil }
            if let obs = endObserver { NotificationCenter.default.removeObserver(obs); endObserver = nil }
            p.pause()
        }
        player = nil     // release the player (and its network load) when leaving
    }
}

/// "Pick up where you left off?" — shown over the player when this account has a saved
/// spot for the video, before playback starts. Mirrors the web viewer's prompt.
struct ResumePrompt: View {
    let seconds: Double
    let onContinue: () -> Void
    let onStartOver: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.6).ignoresSafeArea()
            VStack(spacing: 6) {
                Text("Pick up where you left off?")
                    .font(.headline).foregroundStyle(.white)
                Text("You stopped at \(fmtTime(seconds))")
                    .font(SimplexTheme.mono(11)).foregroundStyle(.white.opacity(0.6))
                HStack(spacing: 10) {
                    Button("Continue", action: onContinue)
                        .buttonStyle(.borderedProminent).tint(SimplexTheme.accent)
                    Button("Start over", action: onStartOver)
                        .buttonStyle(.bordered).tint(.white)
                }
                .padding(.top, 10)
            }
            .padding(22)
            .background(.black.opacity(0.85), in: RoundedRectangle(cornerRadius: 14))
        }
    }

    private func fmtTime(_ t: Double) -> String {
        let total = Int(t.rounded()), h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}

/// Wraps `AVPlayerViewController` so we get the full, standard iOS video controls.
struct SystemVideoPlayer: UIViewControllerRepresentable {
    let player: AVPlayer

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let vc = AVPlayerViewController()
        vc.player = player
        vc.showsPlaybackControls = true      // the full transport bar
        vc.allowsPictureInPicturePlayback = true
        vc.videoGravity = .resizeAspect      // fit inside, preserve aspect (a box, not overfill)
        vc.canStartPictureInPictureAutomaticallyFromInline = true
        return vc
    }
    func updateUIViewController(_ vc: AVPlayerViewController, context: Context) {
        if vc.player !== player { vc.player = player }
    }
}

/// Build an AVPlayer for progressive streaming from the vault, carrying our session
/// cookie so the request is authenticated. Tuned to begin playback quickly:
/// `automaticallyWaitsToMinimizeStalling = false` starts as soon as data is available
/// rather than waiting to buffer a large lead.
func makeStreamingPlayer(url: URL) -> AVPlayer {
    let cookies = HTTPCookieStorage.shared.cookies(for: url) ?? []
    let header = cookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
    var options: [String: Any] = [:]
    if !header.isEmpty { options["AVURLAssetHTTPHeaderFieldsKey"] = ["Cookie": header] }
    let asset = AVURLAsset(url: url, options: options)
    let playerItem = AVPlayerItem(asset: asset)
    // don't over-buffer before starting; let it play as soon as it can
    playerItem.preferredForwardBufferDuration = 2
    let player = AVPlayer(playerItem: playerItem)
    player.automaticallyWaitsToMinimizeStalling = false
    return player
}
