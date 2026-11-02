import SwiftUI

/// Loads an image from the vault over the authenticated session (cookies ride along),
/// with a tiny in-memory cache. Used for both grid thumbnails and the full-size image
/// viewer. Non-image items just show a symbol.
struct Thumbnail: View {
    let item: FileItem

    var body: some View {
        Group {
            if let url = thumbURL {
                CachedAsyncImage(url: url) {
                    placeholder
                }
            } else {
                placeholder
            }
        }
    }

    /// Prefer a server poster (videos, EXR/TIFF), then cover art (audio), then the raw
    /// image itself; folders and plain docs have none → symbol placeholder.
    private var thumbURL: URL? {
        switch item.kind {
        case .image:  return API.shared.posterURL(item) ?? API.shared.rawURL(item)
        case .video:  return API.shared.posterURL(item)
        case .audio:  return API.shared.coverURL(item)
        default:      return API.shared.posterURL(item)
        }
    }

    private var placeholder: some View {
        Image(systemName: symbolName(for: item))
            .font(.system(size: 24))
            .foregroundStyle(item.isFolder ? SimplexTheme.accent : SimplexTheme.subtle)
    }
}

/// Minimal cookie-aware async image with an NSCache. SwiftUI's AsyncImage uses the
/// shared URLSession which does carry HTTPCookieStorage.shared, but rolling our own
/// gives us a cache and lets us reuse the app session's config explicitly.
struct CachedAsyncImage<Placeholder: View>: View {
    let url: URL
    /// When true (grid/list thumbnails) the image fills the box and overflow is clipped.
    /// When false (the fullscreen viewer) it fits inside, preserving aspect ratio.
    let fill: Bool
    @ViewBuilder let placeholder: () -> Placeholder
    @State private var image: UIImage?

    /// Explicit init so `fill` can precede the trailing `placeholder` closure and
    /// default to true (fill) for call sites that omit it.
    init(url: URL, fill: Bool = true, @ViewBuilder placeholder: @escaping () -> Placeholder) {
        self.url = url
        self.fill = fill
        self.placeholder = placeholder
    }

    var body: some View {
        GeometryReader { geo in
            Group {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: fill ? .fill : .fit)
                        .frame(width: geo.size.width, height: geo.size.height)
                } else {
                    placeholder()
                        .frame(width: geo.size.width, height: geo.size.height)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .clipped()
        }
        .task(id: url) { await load() }
    }

    private func load() async {
        if let cached = ImageCache.shared.image(for: url) { image = cached; return }
        do {
            let (data, resp) = try await ImageCache.session.data(from: url)
            guard let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode),
                  let ui = UIImage(data: data) else { return }
            ImageCache.shared.set(ui, for: url)
            image = ui
        } catch { /* leave placeholder */ }
    }
}

final class ImageCache {
    static let shared = ImageCache()
    private let cache = NSCache<NSURL, UIImage>()

    static let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.httpCookieStorage = HTTPCookieStorage.shared
        cfg.httpShouldSetCookies = true
        cfg.requestCachePolicy = .returnCacheDataElseLoad
        return URLSession(configuration: cfg)
    }()

    func image(for url: URL) -> UIImage? { cache.object(forKey: url as NSURL) }
    func set(_ image: UIImage, for url: URL) { cache.setObject(image, forKey: url as NSURL) }
}
