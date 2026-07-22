import SwiftUI

/// Colors pulled from the Simplex web app (index.html theme-color #221f1b, the amber
/// accent #e0a64a used on the bundler thumbnail / primary buttons), so the app reads
/// as the same product.
enum SimplexTheme {
    static let bg      = Color(hex: 0x221f1b)
    static let surface = Color(hex: 0x2b2823)
    static let surface2 = Color(hex: 0x35312b)
    static let accent  = Color(hex: 0xe0a64a)
    static let text    = Color(hex: 0xf2ede4)
    static let subtle  = Color(hex: 0xa39c8e)
    static let line    = Color(hex: 0x3d382f)
}

extension Color {
    init(hex: UInt, alpha: Double = 1) {
        self.init(.sRGB,
                  red:   Double((hex >> 16) & 0xff) / 255,
                  green: Double((hex >> 8) & 0xff) / 255,
                  blue:  Double(hex & 0xff) / 255,
                  opacity: alpha)
    }
}

/// The wordmark used on the login + loading screens.
struct SimplexMark: View {
    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(SimplexTheme.accent).frame(width: 10, height: 10)
            Text("SIMPLEX")
                .font(.system(.title2, design: .rounded)).bold()
                .tracking(2)
                .foregroundStyle(SimplexTheme.text)
        }
    }
}

/// SF Symbol name for a file item, chosen by kind then extension.
func symbolName(for item: FileItem) -> String {
    switch item.kind {
    case .folder:   return "folder.fill"
    case .image:    return "photo"
    case .video:    return "film"
    case .audio:    return "music.note"
    case .document: return "doc.text"
    case .other:    return "doc"
    }
}

/// Human-readable byte size.
func formatBytes(_ n: Int) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
}
