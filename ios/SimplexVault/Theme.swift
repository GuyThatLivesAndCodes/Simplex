import SwiftUI

/// Static proxy over the live `Appearance` model. Views keep referring to
/// `SimplexTheme.accent` etc.; the values now follow the user's chosen accent/theme.
/// (These read `Appearance.shared` on the main actor — all SwiftUI view bodies run
/// there, which is where these are used.)
@MainActor
enum SimplexTheme {
    static var bg: Color { Appearance.shared.bg }
    static var surface: Color { Appearance.shared.surface }
    static var surface2: Color { Appearance.shared.surface2 }
    static var accent: Color { Appearance.shared.accent }
    static var text: Color { Appearance.shared.text }
    static var subtle: Color { Appearance.shared.subtle }
    static var line: Color { Appearance.shared.line }

    /// The monospace font used for metadata/labels (the reference look). `size` in pt.
    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .custom(Appearance.shared.monoFontName(), size: size).weight(weight)
    }
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
            RoundedRectangle(cornerRadius: 4).fill(SimplexTheme.accent).frame(width: 12, height: 12)
            Text("SIMPLEX")
                .font(SimplexTheme.mono(17, weight: .semibold))
                .tracking(3)
                .foregroundStyle(SimplexTheme.text)
        }
    }
}

// MARK: - file type presentation

/// SF Symbol name for a file item, chosen by kind then extension.
func symbolName(for item: FileItem) -> String {
    switch item.kind {
    case .folder:   return "folder.fill"
    case .image:    return "photo.fill"
    case .video:    return "film.fill"
    case .audio:    return "music.note"
    case .document: return "doc.text.fill"
    case .other:    return "doc.fill"
    }
}

/// The short uppercase extension badge shown on tiles (PDF / PNG / TXT / XLSX …).
func typeBadge(for item: FileItem) -> String? {
    if item.isFolder { return nil }
    let ext = (item.name as NSString).pathExtension.uppercased()
    return ext.isEmpty ? nil : String(ext.prefix(4))
}

/// A stable tint per file type, matching the colored icons in the reference design.
/// (MainActor because it reads the live theme; always called from view bodies.)
@MainActor
func tint(for item: FileItem) -> Color {
    switch item.kind {
    case .folder:   return SimplexTheme.accent
    case .image:    return Color(hex: 0x7ed957)   // green
    case .video:    return Color(hex: 0xe6685a)   // coral
    case .audio:    return Color(hex: 0xb07ee6)   // violet
    case .document:
        let ext = (item.name as NSString).pathExtension.lowercased()
        if ext == "pdf" { return Color(hex: 0x5aa9e6) }               // blue
        if ["xlsx","xls","csv","numbers"].contains(ext) { return Color(hex: 0x46c2b6) } // teal
        return Color(hex: 0x5aa9e6)
    case .other:    return SimplexTheme.subtle
    }
}

// MARK: - formatting

/// Human-readable byte size.
func formatBytes(_ n: Int) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
}

/// Compact absolute date like "Jul 18" used on tiles.
func shortDate(_ ms: Double) -> String {
    let f = DateFormatter(); f.dateFormat = "MMM d"
    return f.string(from: Date(timeIntervalSince1970: ms / 1000))
}

/// Relative date like "2h ago", "yesterday", "5d ago" used in Recents.
func relativeDate(_ ms: Double) -> String {
    let date = Date(timeIntervalSince1970: ms / 1000)
    let secs = Date().timeIntervalSince(date)
    if secs < 60 { return "just now" }
    if secs < 3600 { return "\(Int(secs / 60))m ago" }
    if secs < 86400 { return "\(Int(secs / 3600))h ago" }
    let days = Int(secs / 86400)
    if days == 1 { return "yesterday" }
    if days < 30 { return "\(days)d ago" }
    return shortDate(ms)
}

/// The "size · date" metadata line, in monospace to match the reference.
func metaLine(_ item: FileItem) -> String {
    if item.isFolder { return "" }
    return "\(formatBytes(item.size)) · \(shortDate(item.date))"
}
