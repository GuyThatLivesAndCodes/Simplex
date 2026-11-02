import SwiftUI

/// Habit keeps its serif "character" (the display headings) but its COLORS follow the
/// app's chosen appearance — so if the app is dark, Habit is dark too, with no outlier
/// screens (e.g. the shared Account tab). The one habit-specific accent is the app
/// accent, used for check-offs, streaks, and the celebration. Everything else maps to
/// SimplexTheme (which reads a nonisolated snapshot), so no actor isolation is needed
/// and the whole app reads as one product.
enum HabitTheme {
    static var cream: Color      { SimplexTheme.bg }        // page background
    static var card: Color       { SimplexTheme.surface }  // cards / sheets
    static var terracotta: Color { SimplexTheme.accent }   // primary accent (app accent)
    static var terraSoft: Color  { SimplexTheme.accent.opacity(0.6) }
    static var ink: Color        { SimplexTheme.text }      // primary text
    static var inkSoft: Color    { SimplexTheme.subtle }    // secondary text
    static var line: Color       { SimplexTheme.line }      // hairlines
    static var charcoal: Color   { SimplexTheme.surface2 }  // raised/dark cards
    static var done: Color       { SimplexTheme.accent }    // completed accent

    /// A serif display font (New York on iOS) for the big headings — Habit's signature.
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
