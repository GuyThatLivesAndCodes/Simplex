import Foundation

/// A habit as returned by the server (`GET /api/habits`). Includes derived fields the
/// server computes: whether it's done today, the streak, and the full completion-day
/// history (used for grids and insights).
struct Habit: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var note: String?
    var icon: String?
    var slot: String              // morning | afternoon | evening | allday
    var freq: String              // "daily" or a weekday mask
    var reminder: String?         // "HH:MM" or nil
    var sort: Int
    var archived: Bool
    var created: Double

    // server-computed
    var doneToday: Bool?
    var streak: Streak?
    var days: [String]?           // completion days "YYYY-MM-DD"

    struct Streak: Codable, Hashable { var current: Int; var longest: Int }

    var slotEnum: HabitSlot { HabitSlot(rawValue: slot) ?? .allday }
    var isDoneToday: Bool { doneToday == true }
    var currentStreak: Int { streak?.current ?? 0 }
    var longestStreak: Int { streak?.longest ?? 0 }
    var completionDays: Set<String> { Set(days ?? []) }
}

/// A starter habit shown on the Templates screen / onboarding. These are app-side
/// presets (no server needed) that create a real habit when picked.
struct HabitTemplate: Identifiable, Hashable {
    let id: String
    let name: String
    let detail: String
    let icon: String
    let slot: HabitSlot
    let reminder: String?

    static let all: [HabitTemplate] = [
        .init(id: "read",     name: "Read 10 pages",   detail: "Every morning",     icon: "book",     slot: .morning,   reminder: "08:00"),
        .init(id: "walk",     name: "Walk 20 min",     detail: "After lunch",       icon: "walk",     slot: .afternoon, reminder: nil),
        .init(id: "water",    name: "8 glasses of water", detail: "All day",        icon: "water",    slot: .allday,    reminder: nil),
        .init(id: "meditate", name: "Meditate 5 min",  detail: "Before bed",        icon: "meditate", slot: .evening,   reminder: "21:00"),
        .init(id: "pages",    name: "Morning pages",   detail: "3 pages, longhand", icon: "pencil",   slot: .morning,   reminder: nil),
        .init(id: "phone",    name: "No phone at meals", detail: "All day",         icon: "phone",    slot: .allday,    reminder: nil),
        .init(id: "journal",  name: "Journal one thing", detail: "Reminder · 9:00 PM", icon: "pencil", slot: .evening, reminder: "21:00"),
        .init(id: "run",      name: "Run",             detail: "Morning miles",     icon: "run",      slot: .morning,   reminder: "07:00"),
    ]
}

/// Local YYYY-MM-DD helpers (habits are day-accurate in the user's own timezone, so the
/// client is the source of truth for "today").
enum HabitDay {
    static let fmt: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.calendar = Calendar.current
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()
    static func string(_ date: Date = Date()) -> String { fmt.string(from: date) }
    static func date(_ s: String) -> Date? { fmt.date(from: s) }

    static var today: String { string() }
    /// The last `n` days ending today, oldest→newest, as YYYY-MM-DD.
    static func lastDays(_ n: Int) -> [String] {
        (0..<n).reversed().compactMap { i in
            Calendar.current.date(byAdding: .day, value: -i, to: Date()).map { string($0) }
        }
    }
}
