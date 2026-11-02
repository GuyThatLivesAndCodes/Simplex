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

    // goal / measurement
    var goalType: String?         // check | count | timer
    var goalTarget: Double?       // e.g. 8 glasses, 20 minutes
    var unit: String?             // "glasses", "min", "pages"…
    var notify: Bool?             // reminders on for this habit

    // server-computed
    var doneToday: Bool?
    var todayValue: Double?       // progress logged today
    var streak: Streak?
    var days: [String]?           // completed days "YYYY-MM-DD"

    struct Streak: Codable, Hashable { var current: Int; var longest: Int }

    var slotEnum: HabitSlot { HabitSlot(rawValue: slot) ?? .allday }
    var isDoneToday: Bool { doneToday == true }
    var currentStreak: Int { streak?.current ?? 0 }
    var longestStreak: Int { streak?.longest ?? 0 }
    var completionDays: Set<String> { Set(days ?? []) }

    var goal: HabitGoal { HabitGoal(rawValue: goalType ?? "check") ?? .check }
    var target: Double { max(1, goalTarget ?? 1) }
    var progress: Double { todayValue ?? 0 }
    var notifyOn: Bool { notify ?? true }
    /// 0…1 fraction toward the goal today.
    var goalFraction: Double { goal == .check ? (isDoneToday ? 1 : 0) : min(1, progress / target) }
    /// A short progress label like "3 / 8 glasses" or "12 / 20 min".
    var progressLabel: String {
        guard goal != .check else { return isDoneToday ? "Done" : "Not yet" }
        let u = unit.map { " \($0)" } ?? ""
        return "\(Int(progress)) / \(Int(target))\(u)"
    }
}

/// How a habit is measured / completed.
enum HabitGoal: String, CaseIterable, Identifiable, Codable {
    case check    // a simple done/not-done
    case count    // reach a target count (glasses, pages)
    case timer    // reach a target duration (minutes)
    var id: String { rawValue }
    var title: String {
        switch self { case .check: return "Simple"; case .count: return "Count"; case .timer: return "Timer" }
    }
    var defaultUnit: String {
        switch self { case .check: return ""; case .count: return "times"; case .timer: return "min" }
    }
    var icon: String {
        switch self { case .check: return "checkmark.circle"; case .count: return "plus.circle"; case .timer: return "timer" }
    }
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
    var goal: HabitGoal = .check
    var target: Double = 1
    var unit: String? = nil

    static let all: [HabitTemplate] = [
        .init(id: "read",     name: "Read 10 pages",   detail: "Every morning",     icon: "book",     slot: .morning,   reminder: "08:00", goal: .count, target: 10, unit: "pages"),
        .init(id: "walk",     name: "Walk 20 min",     detail: "After lunch",       icon: "walk",     slot: .afternoon, reminder: nil,     goal: .timer, target: 20, unit: "min"),
        .init(id: "water",    name: "8 glasses of water", detail: "All day",        icon: "water",    slot: .allday,    reminder: nil,     goal: .count, target: 8,  unit: "glasses"),
        .init(id: "meditate", name: "Meditate 5 min",  detail: "Before bed",        icon: "meditate", slot: .evening,   reminder: "21:00", goal: .timer, target: 5,  unit: "min"),
        .init(id: "pages",    name: "Morning pages",   detail: "3 pages, longhand", icon: "pencil",   slot: .morning,   reminder: nil,     goal: .count, target: 3,  unit: "pages"),
        .init(id: "phone",    name: "No phone at meals", detail: "All day",         icon: "phone",    slot: .allday,    reminder: nil),
        .init(id: "journal",  name: "Journal one thing", detail: "Reminder · 9:00 PM", icon: "pencil", slot: .evening, reminder: "21:00"),
        .init(id: "run",      name: "Run 1 mile",      detail: "Morning miles",     icon: "run",      slot: .morning,   reminder: "07:00", goal: .count, target: 1, unit: "mi"),
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
