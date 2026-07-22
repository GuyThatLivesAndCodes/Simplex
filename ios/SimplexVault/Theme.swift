import SwiftUI

/// Static proxy over the live theme palette. Views refer to `SimplexTheme.accent` etc.;
/// the values follow the user's chosen accent/theme.
///
/// These read a plain, non-isolated snapshot (`ThemeSnapshot.current`) rather than the
/// `@MainActor` `Appearance` singleton, so they're callable from any context (view
/// bodies, helper properties, global funcs) without actor-isolation friction. The
/// snapshot is refreshed by `Appearance` whenever a pref changes.
enum SimplexTheme {
    static var bg: Color { ThemeSnapshot.current.bg }
    static var surface: Color { ThemeSnapshot.current.surface }
    static var surface2: Color { ThemeSnapshot.current.surface2 }
    static var accent: Color { ThemeSnapshot.current.accent }
    static var text: Color { ThemeSnapshot.current.text }
    static var subtle: Color { ThemeSnapshot.current.subtle }
    static var line: Color { ThemeSnapshot.current.line }

    /// The monospace font used for metadata/labels (the reference look). `size` in pt.
    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .custom(ThemeSnapshot.current.monoFont, size: size).weight(weight)
    }
}

/// A value snapshot of the current palette, held in a plain global so the static
/// `SimplexTheme` accessors don't need main-actor isolation. `Appearance.applySnapshot()`
/// rewrites `current` on every change. (Written and read on the main thread in practice;
/// the project builds in Swift 5 language mode, where this static var needs no extra
/// concurrency annotation.)
struct ThemeSnapshot {
    var bg: Color; var surface: Color; var surface2: Color
    var accent: Color; var text: Color; var subtle: Color; var line: Color
    var monoFont: String

    static let fallback = ThemeSnapshot(
        bg: Color(hex: 0x221f1b), surface: Color(hex: 0x2b2823), surface2: Color(hex: 0x35312b),
        accent: Color(hex: 0xe0a64a), text: Color(hex: 0xf2ede4), subtle: Color(hex: 0xa39c8e),
        line: Color(hex: 0x3d382f), monoFont: "Menlo")

    static var current = ThemeSnapshot.fallback
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
/// Named `typeTint` to avoid colliding with SwiftUI's `.tint()` view modifier.
func typeTint(for item: FileItem) -> Color {
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
