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

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let player {
                SystemVideoPlayer(player: player)
                    .ignoresSafeArea(edges: .bottom)
            } else {
                ProgressView().tint(SimplexTheme.accent)
            }
        }
        .navigationTitle(item.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.black, for: .navigationBar)
        .onAppear {
            if player == nil, let url = API.shared.rawURL(item) {
                player = makeStreamingPlayer(url: url)
                player?.play()
            }
        }
        .onDisappear {
            player?.pause()
            player = nil     // release the player (and its network load) when leaving
        }
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
