import Foundation

/// Local-first storage for the Habit system. The PHONE is the source of truth: every
/// habit and every day's progress lives in one JSON document on device, and all
/// completion / streak / goal logic is computed here. The server is only a backup
/// target (opaque per-day snapshots). This makes Habit fast and fully usable offline —
/// it never waits on the network.
struct HabitDoc: Codable {
    var version = 2
    var habits: [HabitDef] = []
    /// habitId -> (day 'YYYY-MM-DD' -> logged progress value). `done` is NOT stored — it
    /// is derived live from value vs. the habit's CURRENT target, so editing a goal
    /// re-evaluates correctly and never rewrites history.
    var logs: [String: [String: Double]] = [:]
    var updated: Double = 0
}

/// A habit definition (no per-day state — that's in `logs`).
struct HabitDef: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var note: String?
    var icon: String?
    var slot: String
    var freq: String
    var reminder: String?
    var sort: Int
    var archived: Bool
    var created: Double
    var goalType: String
    var goalTarget: Double
    var unit: String?
    var notify: Bool

    static func new(name: String, slot: HabitSlot, icon: String?, reminder: String?, freq: String,
                    goal: HabitGoal, target: Double, unit: String?, notify: Bool, sort: Int) -> HabitDef {
        let raw = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        return HabitDef(id: "h" + String(raw.prefix(16)),
                 name: name, note: nil, icon: icon, slot: slot.rawValue, freq: freq,
                 reminder: reminder, sort: sort, archived: false, created: Date().timeIntervalSince1970 * 1000,
                 goalType: goal.rawValue, goalTarget: max(1, target), unit: unit, notify: notify)
    }
}

/// Reads/writes the HabitDoc JSON file in the app's Documents directory.
enum HabitLocalStore {
    private static var url: URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("habits.json")
    }

    static func load() -> HabitDoc {
        guard let data = try? Data(contentsOf: url),
              let doc = try? JSONDecoder().decode(HabitDoc.self, from: data) else { return HabitDoc() }
        return doc
    }

    static func save(_ doc: HabitDoc) {
        var d = doc; d.updated = Date().timeIntervalSince1970 * 1000
        if let data = try? JSONEncoder().encode(d) {
            try? data.write(to: url, options: .atomic)
        }
    }

    static func exists() -> Bool { FileManager.default.fileExists(atPath: url.path) }

    /// Serialize the doc to a JSON string for a backup snapshot.
    static func snapshotJSON(_ doc: HabitDoc) -> String {
        guard let data = try? JSONEncoder().encode(doc),
              let s = String(data: data, encoding: .utf8) else { return "{}" }
        return s
    }
    static func decodeSnapshot(_ json: String) -> HabitDoc? {
        guard let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(HabitDoc.self, from: data)
    }
}

/// Build the view-facing `Habit` (with today's derived state) from a def + the log map.
/// This is where `done`/`streak`/`todayValue` are computed LIVE against the current goal.
func makeHabit(_ def: HabitDef, logs: [String: Double], today: String) -> Habit {
    let target = max(1, def.goalTarget)
    // a day is "done" if that day's logged value reached the CURRENT target
    let doneDays = logs.filter { $0.value >= target }.map { $0.key }.sorted()
    let todayValue = logs[today] ?? 0
    let streak = computeStreak(Set(doneDays), today: today)
    return Habit(
        id: def.id, name: def.name, note: def.note, icon: def.icon,
        slot: def.slot, freq: def.freq, reminder: def.reminder, sort: def.sort,
        archived: def.archived, created: def.created,
        goalType: def.goalType, goalTarget: def.goalTarget, unit: def.unit, notify: def.notify,
        doneToday: todayValue >= target, todayValue: todayValue,
        streak: Habit.Streak(current: streak.current, longest: streak.longest),
        days: doneDays
    )
}

/// Current + longest consecutive-day streak ending at/around `today`.
func computeStreak(_ doneDays: Set<String>, today: String) -> (current: Int, longest: Int) {
    let dayMs = 86400.0
    guard let base = HabitDay.date(today) else { return (0, 0) }
    // current: count back from today (today optional — a not-yet-done today doesn't break it)
    var current = 0
    var cursor = doneDays.contains(today) ? base : base.addingTimeInterval(-dayMs)
    while doneDays.contains(HabitDay.string(cursor)) {
        current += 1
        cursor = cursor.addingTimeInterval(-dayMs)
    }
    // longest across all done days
    let sorted = doneDays.compactMap { HabitDay.date($0) }.sorted()
    var longest = 0, run = 0
    var prev: Date?
    for d in sorted {
        if let p = prev, abs(d.timeIntervalSince(p) - dayMs) < 1 { run += 1 } else { run = 1 }
        longest = max(longest, run); prev = d
    }
    return (current, longest)
}
