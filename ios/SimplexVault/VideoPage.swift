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

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let player {
                SystemVideoPlayer(player: player)
                    .ignoresSafeArea(edges: .bottom)
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

        // resume from the saved position, if any
        if let secs = VideoProgress.position(for: item.id) {
            p.seek(to: CMTime(seconds: secs, preferredTimescale: 600))
            resumedShown = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { withAnimation { resumedShown = false } }
        }
        p.play()

        // auto-save the position every 5s during playback so an accidental close keeps
        // your place
        let interval = CMTime(seconds: 5, preferredTimescale: 600)
        timeObserver = p.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [item] time in
            let secs = time.seconds
            let dur = p.currentItem?.duration.seconds ?? 0
            guard secs.isFinite, secs > 0 else { return }
            VideoProgress.save(fileId: item.id, seconds: secs, duration: dur.isFinite ? dur : 0)
        }
        player = p
    }

    private func stop() {
        // save the exact position on the way out, then tear down
        if let p = player {
            let secs = p.currentTime().seconds
            let dur = p.currentItem?.duration.seconds ?? 0
            if secs.isFinite, secs > 0 {
                VideoProgress.save(fileId: item.id, seconds: secs, duration: dur.isFinite ? dur : 0)
            }
            if let obs = timeObserver { p.removeTimeObserver(obs); timeObserver = nil }
            p.pause()
        }
        player = nil     // release the player (and its network load) when leaving
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
