import SwiftUI

/// Habit's own self-contained look — a warm cream + terracotta palette with serif
/// display headings, per the reference. Independent of the vault's dark theme and the
/// user's accent choice (Habit is a distinct, deliberately-calm space).
enum HabitTheme {
    static let cream      = Color(hex: 0xf4ece0)   // page background
    static let card       = Color(hex: 0xfbf6ee)   // cards / sheets
    static let terracotta = Color(hex: 0xc0603f)   // primary accent
    static let terraSoft  = Color(hex: 0xd98a68)   // lighter accent
    static let ink        = Color(hex: 0x2b2420)   // primary text
    static let inkSoft    = Color(hex: 0x8a7d70)   // secondary text
    static let line       = Color(hex: 0xe3d8c8)   // hairlines
    static let charcoal   = Color(hex: 0x241f1b)   // dark cards (progress banner)
    static let done       = Color(hex: 0xc0603f)   // completed accent

    /// A serif display font (New York on iOS) for the big headings in the reference.
    static func serif(_ size: CGFloat, weight: Font.Weight = .regular, italic: Bool = false) -> Font {
        let base = Font.system(size: size, weight: weight, design: .serif)
        return italic ? base.italic() : base
    }
    /// The small UPPERCASE label style (e.g. "MORNING", "WEDNESDAY").
    static func label(_ size: CGFloat = 11) -> Font {
        .system(size: size, weight: .semibold, design: .default)
    }
}

/// SF Symbol for a habit icon key (matches the add-habit icon row).
func habitIcon(_ key: String?) -> String {
    switch key {
    case "book":     return "book.closed.fill"
    case "walk":     return "figure.walk"
    case "water":    return "drop.fill"
    case "meditate": return "circle.circle"
    case "pencil":   return "pencil"
    case "phone":    return "iphone.slash"
    case "run":      return "figure.run"
    case "sleep":    return "moon.fill"
    case "food":     return "fork.knife"
    case "heart":    return "heart.fill"
    default:         return "circle.dashed"
    }
}

/// The ordered icon choices shown in the add-habit sheet.
let HABIT_ICON_KEYS = ["water", "book", "walk", "meditate", "pencil", "phone", "run", "sleep", "food", "heart"]

/// The four time-of-day slots, in display order.
enum HabitSlot: String, CaseIterable, Identifiable, Codable {
    case morning, afternoon, evening, allday
    var id: String { rawValue }
    var title: String {
        switch self {
        case .morning: return "Morning"
        case .afternoon: return "Afternoon"
        case .evening: return "Evening"
        case .allday: return "All-day"
        }
    }
}
