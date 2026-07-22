import SwiftUI
import AVKit

/// Opens a single file in the right viewer for its kind. Streaming media plays via
/// AVPlayer against `/api/files/{id}/raw`; the server keeps Range/seek working, so
/// scrubbing is smooth. Documents pull their text from `/content`.
struct FileViewer: View {
    @EnvironmentObject var store: Store
    let item: FileItem
    @State private var shareURL: URL?

    var body: some View {
        Group {
            switch item.kind {
            case .image:    ImageViewer(item: item)
            case .video:    MediaPlayer(item: item)
            case .audio:    AudioViewer(item: item)
            case .document: DocumentViewer(item: item)
            default:        UnsupportedViewer(item: item)
            }
        }
        .background(SimplexTheme.bg.ignoresSafeArea())
        .navigationTitle(item.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { share() } label: { Image(systemName: "square.and.arrow.up") }
            }
        }
    }

    private func share() {
        Task {
            do {
                let url = try await API.shared.download(item)
                await MainActor.run { present(url) }
            } catch { store.handle(error) }
        }
    }

    private func present(_ url: URL) {
        let av = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let root = scene.windows.first?.rootViewController else { return }
        var top = root
        while let p = top.presentedViewController { top = p }
        top.present(av, animated: true)
    }
}

// MARK: - image

struct ImageViewer: View {
    let item: FileItem
    var body: some View {
        if let url = API.shared.rawURL(item) {
            ZoomableImage(url: url)
        } else {
            UnsupportedViewer(item: item)
        }
    }
}

/// Pinch-to-zoom + pan over a full-size cookie-authenticated image.
struct ZoomableImage: View {
    let url: URL
    @State private var scale: CGFloat = 1
    @State private var offset: CGSize = .zero

    var body: some View {
        CachedAsyncImage(url: url) {
            ProgressView().tint(SimplexTheme.accent)
        }
        .scaledToFit()
        .scaleEffect(scale)
        .offset(offset)
        .gesture(
            MagnificationGesture()
                .onChanged { scale = max(1, $0) }
                .onEnded { _ in if scale < 1.05 { withAnimation { scale = 1; offset = .zero } } }
        )
        .simultaneousGesture(
            DragGesture()
                .onChanged { if scale > 1 { offset = $0.translation } }
                .onEnded { _ in if scale <= 1 { withAnimation { offset = .zero } } }
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - video / audio via AVPlayer

/// AVPlayer over the raw stream. A cookie-carrying AVURLAsset lets the player
/// authenticate; the server supports Range so seeking works.
struct MediaPlayer: View {
    let item: FileItem
    @State private var player: AVPlayer?

    var body: some View {
        VideoPlayer(player: player)
            .ignoresSafeArea(edges: .bottom)
            .onAppear { start() }
            .onDisappear { player?.pause() }
    }

    private func start() {
        guard player == nil, let url = API.shared.rawURL(item) else { return }
        player = makeCookiePlayer(url: url)
        player?.play()
    }
}

struct AudioViewer: View {
    let item: FileItem
    @State private var player: AVPlayer?

    var body: some View {
        VStack(spacing: 24) {
            // cover art if present, else a music glyph
            if let cover = API.shared.coverURL(item) {
                CachedAsyncImage(url: cover) {
                    coverPlaceholder
                }
                .frame(width: 220, height: 220)
                .clipShape(RoundedRectangle(cornerRadius: 16))
            } else {
                coverPlaceholder.frame(width: 220, height: 220)
            }
            VStack(spacing: 4) {
                Text(item.name).font(.headline).foregroundStyle(SimplexTheme.text)
                    .multilineTextAlignment(.center)
                if let artist = item.artist {
                    Text(artist).font(.subheadline).foregroundStyle(SimplexTheme.subtle)
                }
            }
            if let player { VideoPlayer(player: player).frame(height: 80) }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            if player == nil, let url = API.shared.rawURL(item) {
                player = makeCookiePlayer(url: url); player?.play()
            }
        }
        .onDisappear { player?.pause() }
    }

    private var coverPlaceholder: some View {
        RoundedRectangle(cornerRadius: 16).fill(SimplexTheme.surface2)
            .overlay(Image(systemName: "music.note").font(.system(size: 48))
                .foregroundStyle(SimplexTheme.subtle))
    }
}

/// Build an AVPlayer whose asset sends our session cookies with each request.
func makeCookiePlayer(url: URL) -> AVPlayer {
    let cookies = HTTPCookieStorage.shared.cookies(for: url) ?? []
    let header = cookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
    let options: [String: Any] = header.isEmpty ? [:] :
        ["AVURLAssetHTTPHeaderFieldsKey": ["Cookie": header]]
    let asset = AVURLAsset(url: url, options: options)
    let item = AVPlayerItem(asset: asset)
    return AVPlayer(playerItem: item)
}

// MARK: - document

struct DocumentViewer: View {
    let item: FileItem
    @EnvironmentObject var store: Store
    @State private var text: String?
    @State private var loading = true

    var body: some View {
        ScrollView {
            if loading {
                ProgressView().tint(SimplexTheme.accent).padding(40)
            } else if let text {
                Text(text.isEmpty ? "(empty file)" : text)
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(SimplexTheme.text)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            } else {
                Text("Couldn't load this document.")
                    .foregroundStyle(SimplexTheme.subtle).padding()
            }
        }
        .task { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            if item.hasContent == true {
                text = try await API.shared.docContent(id: item.id)
            } else if let url = API.shared.rawURL(item) {
                // blob-backed text: fetch the raw bytes and decode as UTF-8
                let (data, _) = try await ImageCache.session.data(from: url)
                text = String(data: data, encoding: .utf8) ?? "(binary file — use Save / Share to open)"
            } else {
                text = ""
            }
        } catch { store.handle(error); text = nil }
    }
}

// MARK: - fallback

struct UnsupportedViewer: View {
    let item: FileItem
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbolName(for: item))
                .font(.system(size: 52)).foregroundStyle(SimplexTheme.subtle)
            Text(item.name).foregroundStyle(SimplexTheme.text)
            Text(formatBytes(item.size)).font(.footnote).foregroundStyle(SimplexTheme.subtle)
            Text("Preview isn't supported for this file type. Use Save / Share to open it in another app.")
                .font(.footnote).foregroundStyle(SimplexTheme.subtle)
                .multilineTextAlignment(.center).padding(.horizontal, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
