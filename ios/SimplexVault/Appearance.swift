import SwiftUI

/// Mirrors the web app's PREFS appearance vocabulary (app.js ACCENTS / THEMES / FONTS /
/// DEFAULT_PREFS) so what the user picks here round-trips through `accounts.prefs` and
/// stays consistent with the website. Only the appearance-relevant keys are modeled;
/// unknown keys in the prefs blob are preserved untouched on save.
///
/// This is an ObservableObject the whole UI observes, so changing accent/theme is live.
@MainActor
final class Appearance: ObservableObject {
    static let shared = Appearance()

    // The real PREFS keys (values match the website exactly).
    @Published var accentHex: String?   // nil = Amber default (#e0a64a)
    @Published var themeId: String      // charcoal | slate | midnight | contrast | daylight | frost
    @Published var bgFx: String         // aurora | glow | grain | none  (fire omitted — heavy)
    @Published var uiFont: String       // plex | inter | grotesk | system
    @Published var monoFont: String     // plexmono | jetbrains | fira | system
    @Published var defaultGrid: Bool    // true = grid, false = list (maps to app’s own default view)

    /// Face ID privacy screen — an app-local pref (not a website PREFS key), stored in
    /// UserDefaults, read by the privacy overlay.
    @AppStorage("faceIDLock") var faceIDLock: Bool = true

    private init() {
        accentHex = UserDefaults.standard.string(forKey: "pref.accent")
        themeId   = UserDefaults.standard.string(forKey: "pref.theme") ?? "charcoal"
        bgFx      = UserDefaults.standard.string(forKey: "pref.bgFx") ?? "aurora"
        uiFont    = UserDefaults.standard.string(forKey: "pref.uiFont") ?? "plex"
        monoFont  = UserDefaults.standard.string(forKey: "pref.monoFont") ?? "plexmono"
        defaultGrid = (UserDefaults.standard.object(forKey: "pref.grid") as? Bool) ?? true
        applySnapshot()
    }

    /// Push the current palette into the nonisolated `ThemeSnapshot` that `SimplexTheme`
    /// reads. Called on init and after any appearance change. objectWillChange also fires
    /// (via @Published), so observing views re-render with the new snapshot.
    func applySnapshot() {
        ThemeSnapshot.current = ThemeSnapshot(
            bg: bg, surface: surface, surface2: surface2, accent: accent,
            text: text, subtle: subtle, line: line, monoFont: monoFontName())
    }

    /// Load appearance from the account's server-side prefs blob (on sign-in).
    func load(from prefs: [String: AnyCodable]?) {
        guard let prefs else { return }
        if let a = prefs["accent"]?.value as? String { accentHex = a }
        else if prefs["accent"] != nil { accentHex = nil }   // explicit null = default
        if let t = prefs["theme"]?.value as? String { themeId = t }
        if let b = prefs["bgFx"]?.value as? String { bgFx = b }
        if let u = prefs["uiFont"]?.value as? String { uiFont = u }
        if let m = prefs["monoFont"]?.value as? String { monoFont = m }
        persistLocal()
        applySnapshot()
    }

    /// The appearance keys as a prefs patch to PATCH back to the server.
    var prefsPatch: [String: Any?] {
        [
            "accent": accentHex,          // may be nil (= amber default)
            "theme": themeId,
            "bgFx": bgFx,
            "uiFont": uiFont,
            "monoFont": monoFont,
        ]
    }

    func persistLocal() {
        let d = UserDefaults.standard
        d.set(accentHex, forKey: "pref.accent")
        d.set(themeId, forKey: "pref.theme")
        d.set(bgFx, forKey: "pref.bgFx")
        d.set(uiFont, forKey: "pref.uiFont")
        d.set(monoFont, forKey: "pref.monoFont")
        d.set(defaultGrid, forKey: "pref.grid")
        applySnapshot()
    }

    // ---- derived colors / fonts ----

    /// The live accent color (custom hex, or the Simplex amber default).
    var accent: Color {
        if let hex = accentHex, let c = Color(hexString: hex) { return c }
        return Color(hex: 0xe0a64a)
    }

    var isLight: Bool { themeId == "daylight" || themeId == "frost" }

    /// Surface palette per theme. Only a handful are fully tuned; the rest fall back to
    /// the charcoal dark set (still readable, just not bespoke).
    var bg: Color {
        switch themeId {
        case "slate":    return Color(hex: 0x20242c)
        case "midnight": return Color(hex: 0x191c2c)
        case "contrast": return Color(hex: 0x101010)
        case "daylight": return Color(hex: 0xf2eee4)
        case "frost":    return Color(hex: 0xeef2f7)
        default:         return Color(hex: 0x221f1b)   // charcoal
        }
    }
    var surface: Color {
        switch themeId {
        case "slate":    return Color(hex: 0x2a2f38)
        case "midnight": return Color(hex: 0x232741)
        case "contrast": return Color(hex: 0x1b1b1b)
        case "daylight": return Color(hex: 0xfbf8f1)
        case "frost":    return Color(hex: 0xf7fafd)
        default:         return Color(hex: 0x2b2823)
        }
    }
    var surface2: Color {
        switch themeId {
        case "daylight": return Color(hex: 0xece6d8)
        case "frost":    return Color(hex: 0xe4ebf2)
        case "slate":    return Color(hex: 0x343a45)
        case "midnight": return Color(hex: 0x2d3355)
        case "contrast": return Color(hex: 0x262626)
        default:         return Color(hex: 0x35312b)
        }
    }
    var text: Color { isLight ? Color(hex: 0x2a2622) : Color(hex: 0xf2ede4) }
    var subtle: Color { isLight ? Color(hex: 0x7a7266) : Color(hex: 0xa39c8e) }
    var line: Color { isLight ? Color(hex: 0xd9d2c4) : Color(hex: 0x3d382f) }

    var colorScheme: ColorScheme { isLight ? .light : .dark }

    /// UI + monospace font families (falls back to the system font when the custom
    /// family isn't bundled — the web fonts aren't shipped in the app).
    func uiFontName() -> String? {
        switch uiFont {
        case "inter":   return "Inter"
        case "grotesk": return "Space Grotesk"
        case "system":  return nil
        default:        return "IBMPlexSans-Regular"   // may be absent → system fallback
        }
    }
    func monoFontName() -> String {
        switch monoFont {
        case "jetbrains": return "JetBrains Mono"
        case "fira":      return "Fira Code"
        case "system":    return "Menlo"
        default:          return "Menlo"   // Plex Mono not bundled; Menlo is the closest system mono
        }
    }
}

/// Minimal type-erased Codable value so we can read the server's freeform prefs blob
/// without modeling every key. Hashable so the containing `Account` can be Hashable
/// (equality/hash use a normalized string form of the underlying value).
struct AnyCodable: Codable, Hashable {
    let value: Any
    init(_ value: Any) { self.value = value }
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let b = try? c.decode(Bool.self) { value = b }
        else if let i = try? c.decode(Int.self) { value = i }
        else if let d = try? c.decode(Double.self) { value = d }
        else if let s = try? c.decode(String.self) { value = s }
        else if c.decodeNil() { value = NSNull() }
        else { value = NSNull() }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch value {
        case let b as Bool: try c.encode(b)
        case let i as Int: try c.encode(i)
        case let d as Double: try c.encode(d)
        case let s as String: try c.encode(s)
        default: try c.encodeNil()
        }
    }
    /// A stable string key for hashing/equality across the boxed primitive types.
    private var key: String {
        switch value {
        case let b as Bool: return "b:\(b)"
        case let i as Int: return "i:\(i)"
        case let d as Double: return "d:\(d)"
        case let s as String: return "s:\(s)"
        default: return "null"
        }
    }
    static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool { lhs.key == rhs.key }
    func hash(into hasher: inout Hasher) { hasher.combine(key) }
}

extension Color {
    /// Parse "#rrggbb" or "rrggbb".
    init?(hexString: String) {
        var s = hexString.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let n = UInt32(s, radix: 16) else { return nil }
        self.init(hex: UInt(n))
    }
}

/// The catalog of choices shown in the appearance settings (labels + values match the
/// website's ACCENTS / THEMES / FONTS lists).
enum AppearanceCatalog {
    static let accents: [(name: String, hex: String?)] = [
        ("Amber", nil), ("Blue", "#5aa9e6"), ("Green", "#7ed957"),
        ("Coral", "#e6685a"), ("Violet", "#b07ee6"), ("Teal", "#46c2b6"),
        ("Pink", "#e6a0c4"), ("Crimson", "#d9506b"), ("Ice", "#a8cbe8"), ("Sage", "#9fbf8f"),
    ]
    static let themes: [(id: String, label: String)] = [
        ("charcoal", "Warm charcoal"), ("slate", "Cool slate"), ("midnight", "Midnight"),
        ("contrast", "High contrast"), ("daylight", "Daylight"), ("frost", "Frost"),
    ]
    static let ambience: [(id: String, label: String)] = [
        ("aurora", "Aurora"), ("glow", "Glow"), ("grain", "Grain"), ("none", "None"),
    ]
    static let uiFonts: [(key: String, label: String)] = [
        ("plex", "IBM Plex Sans"), ("inter", "Inter"), ("grotesk", "Space Grotesk"), ("system", "System"),
    ]
    static let monoFonts: [(key: String, label: String)] = [
        ("plexmono", "IBM Plex Mono"), ("jetbrains", "JetBrains Mono"), ("fira", "Fira Code"), ("system", "System Mono"),
    ]
}
