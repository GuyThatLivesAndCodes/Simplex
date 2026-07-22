import SwiftUI
import AVKit

/// Fullscreen, swipeable media viewer. Opened for a photo or video; swipe left/right to
/// move through every image & video in the SAME folder. Videos support AirPlay (cast to
/// a TV) via the system route picker. Presented as a full-screen cover so it truly fills
/// the screen (no nav/tab chrome).
struct MediaGallery: View {
    @Environment(\.dismiss) private var dismiss
    let items: [FileItem]        // same-folder media, in display order
    @State var index: Int        // starting item
    @State private var showChrome = true

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            TabView(selection: $index) {
                ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                    Group {
                        switch item.kind {
                        case .image:
                            // images: tap toggles the chrome (close/caption); zoom + pan gestures live inside
                            FullImage(item: item)
                                .contentShape(Rectangle())
                                .onTapGesture { withAnimation { showChrome.toggle() } }
                        case .video:
                            // videos: the native player owns all touches so its transport
                            // controls (play/pause, scrubber, speed, fullscreen) work. We
                            // do NOT add a tap gesture here — that was swallowing taps meant
                            // for the scrubber, leaving the video with no controls.
                            FullVideo(item: item, isCurrent: i == index)
                        default:
                            Color.black
                        }
                    }
                    .tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .ignoresSafeArea()

            let isVideo = items.indices.contains(index) && items[index].kind == .video
            // Top bar: always show a close button; AirPlay for videos. For videos we keep
            // it always visible (there's no tap-to-toggle) but tucked into the safe area so
            // it doesn't overlap the player's own top controls.
            if showChrome || isVideo {
                VStack {
                    HStack {
                        Button { dismiss() } label: {
                            Image(systemName: "xmark")
                                .font(.title3.bold()).foregroundStyle(.white)
                                .padding(10).background(.black.opacity(0.45), in: Circle())
                        }
                        Spacer()
                        if isVideo {
                            RoutePickerButton()
                                .frame(width: 44, height: 44)
                                .background(.black.opacity(0.45), in: Circle())
                        }
                    }
                    .padding(.horizontal, 16).padding(.top, 8)
                    Spacer()
                    // caption only for images (a video's scrubber lives at the bottom)
                    if showChrome && !isVideo && items.indices.contains(index) {
                        VStack(spacing: 2) {
                            Text(items[index].name).foregroundStyle(.white).font(.callout).lineLimit(1)
                            Text("\(index + 1) of \(items.count)").foregroundStyle(.white.opacity(0.7))
                                .font(SimplexTheme.mono(11))
                        }
                        .padding(.bottom, 24)
                    }
                }
                .transition(.opacity)
                .allowsHitTesting(true)
            }
        }
        .statusBarHidden(isVideoFullscreen ? false : !showChrome)
    }

    private var isVideoFullscreen: Bool {
        items.indices.contains(index) && items[index].kind == .video
    }
}

/// Full-bleed zoomable image inside the gallery.
private struct FullImage: View {
    let item: FileItem
    @State private var scale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    var body: some View {
        GeometryReader { _ in
            if let url = API.shared.rawURL(item) {
                CachedAsyncImage(url: url, fill: false) { ProgressView().tint(.white) }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .scaleEffect(scale)
                    .offset(offset)
                    .gesture(zoom)
                    .gesture(pan)
                    .onTapGesture(count: 2) { withAnimation { reset() } }
            }
        }
    }
    private var zoom: some Gesture {
        MagnificationGesture()
            .onChanged { scale = max(1, min(4, $0)) }
            .onEnded { _ in if scale < 1.05 { withAnimation { reset() } } }
    }
    private var pan: some Gesture {
        DragGesture()
            .onChanged { if scale > 1 { offset = CGSize(width: lastOffset.width + $0.translation.width,
                                                        height: lastOffset.height + $0.translation.height) } }
            .onEnded { _ in lastOffset = offset }
    }
    private func reset() { scale = 1; offset = .zero; lastOffset = .zero }
}

/// Full-bleed video with playback controls; plays via cookie-authenticated AVPlayer.
private struct FullVideo: View {
    let item: FileItem
    let isCurrent: Bool
    @State private var player: AVPlayer?

    var body: some View {
        VideoPlayer(player: player)
            .ignoresSafeArea()
            .onAppear { if player == nil, let url = API.shared.rawURL(item) { player = makeCookiePlayer(url: url) } }
            .onChange(of: isCurrent) { current in
                if current { player?.play() } else { player?.pause() }
            }
            .onDisappear { player?.pause() }
    }
}

/// UIKit AVRoutePickerView wrapped for SwiftUI — the standard AirPlay button that lets
/// the user pick a TV / AirPlay receiver to stream the video to.
struct RoutePickerButton: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let v = AVRoutePickerView()
        v.tintColor = .white
        v.activeTintColor = UIColor(SimplexTheme.accent)
        v.prioritizesVideoDevices = true
        return v
    }
    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}
