import SwiftUI

/// Fullscreen, swipeable PHOTO viewer. Opened for an image; swipe left/right to move
/// through every image in the same folder. Pinch-to-zoom and double-tap to reset.
/// (Videos open in a standard AVPlayer page — see VideoPage — which has the full native
/// control bar and its own fullscreen button.)
struct MediaGallery: View {
    @Environment(\.dismiss) private var dismiss
    let items: [FileItem]        // same-folder images, in display order
    @State var index: Int        // starting item
    @State private var showChrome = true

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            TabView(selection: $index) {
                ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                    FullImage(item: item)
                        .contentShape(Rectangle())
                        .onTapGesture { withAnimation { showChrome.toggle() } }
                        .tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .ignoresSafeArea()

            if showChrome {
                VStack {
                    HStack {
                        Button { dismiss() } label: {
                            Image(systemName: "xmark")
                                .font(.title3.bold()).foregroundStyle(.white)
                                .padding(10).background(.black.opacity(0.45), in: Circle())
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 16).padding(.top, 8)
                    Spacer()
                    if items.indices.contains(index) {
                        VStack(spacing: 2) {
                            Text(items[index].name).foregroundStyle(.white).font(.callout).lineLimit(1)
                            Text("\(index + 1) of \(items.count)").foregroundStyle(.white.opacity(0.7))
                                .font(SimplexTheme.mono(11))
                        }
                        .padding(.bottom, 24)
                    }
                }
                .transition(.opacity)
            }
        }
        .statusBarHidden(!showChrome)
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
