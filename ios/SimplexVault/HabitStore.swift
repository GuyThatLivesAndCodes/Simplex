import Foundation
import SwiftUI

/// LOCAL-FIRST state for the Habit system. The phone owns the data (a HabitDoc on disk);
/// every mutation is instant and offline. The server is only a backup target — a daily
/// snapshot is pushed in the background (debounced). Nothing here waits on the network,
/// so Habit works even when the server is down.
@MainActor
final class HabitStore: ObservableObject {
    @Published private(set) var doc = HabitDoc()
    @Published var loaded = false
    @Published var error: String?
    /// One celebration per day, guarded on the store (survives view rebuilds).
    var celebratedForDay = ""

    private var backupTask: Task<Void, Never>?

    // MARK: - derived view models (computed live from the local doc)

    /// The view-facing habits with today's derived state (done/streak/progress).
    var habits: [Habit] {
        let today = HabitDay.today
        return doc.habits.map { makeHabit($0, logs: doc.logs[$0.id] ?? [:], today: today) }
    }

    func habits(in slot: HabitSlot) -> [Habit] {
        habits.filter { !$0.archived && $0.slotEnum == slot }.sorted { $0.sort < $1.sort }
    }
    var activeHabits: [Habit] { habits.filter { !$0.archived }.sorted { $0.sort < $1.sort } }
    var archivedHabits: [Habit] { habits.filter { $0.archived } }

    var visibleSlots: [HabitSlot] {
        HabitSlot.allCases.filter { !habits(in: $0).isEmpty }.sorted { $0.timelineRank < $1.timelineRank }
    }

    var doneCount: Int { activeHabits.filter { $0.isDoneToday }.count }
    var totalCount: Int { activeHabits.count }
    var allDone: Bool { totalCount > 0 && doneCount == totalCount }
    var fractionDone: Double { totalCount == 0 ? 0 : Double(doneCount) / Double(totalCount) }
    func doneCount(in slot: HabitSlot) -> Int { habits(in: slot).filter { $0.isDoneToday }.count }

    private func def(_ id: String) -> HabitDef? { doc.habits.first { $0.id == id } }
    private var nextSort: Int { (doc.habits.map { $0.sort }.max() ?? 0) + 1 }

    // MARK: - load (local first, restore from server only if the phone is empty)

    func load() async {
        doc = HabitLocalStore.load()
        loaded = true
        // Fresh install (no local file yet, no habits): try to auto-restore the latest
        // server backup so a reinstall/new device recovers the user's habits. If local
        // already has data, it WINS — the server never silently overwrites the phone.
        if doc.habits.isEmpty && !HabitLocalStore.exists() {
            if let restored = try? await API.shared.latestHabitBackup(), !restored.habits.isEmpty {
                doc = restored
                persist(backup: false)   // it already matches the server
            }
        }
        HabitNotifications.reschedule(habits)
    }

    // MARK: - mutations (all local + instant; server backup is background)

    func toggle(_ habit: Habit) {
        guard let d = def(habit.id) else { return }
        let today = HabitDay.today
        let cur = doc.logs[d.id]?[today] ?? 0
        // done? clear it. not done? jump to the goal target (a full completion).
        setValue(cur >= d.goalTarget ? 0 : d.goalTarget, for: d.id, day: today)
    }

    /// Force-complete (slide-to-finish).
    func complete(_ habit: Habit) {
        guard let d = def(habit.id) else { return }
        setValue(d.goalTarget, for: d.id, day: HabitDay.today)
    }

    /// Add to today's progress for a counter/timer (e.g. +1 glass). CLAMPED so it can
    /// only reach the current target from raising the count — never overshoots and never
    /// auto-completes early (this is the fix for the edit-goal counter bug).
    func add(_ habit: Habit, delta: Double) {
        guard let d = def(habit.id) else { return }
        let today = HabitDay.today
        let cur = doc.logs[d.id]?[today] ?? 0
        let next = max(0, min(cur + delta, d.goalTarget))
        setValue(next, for: d.id, day: today)
    }

    /// Set an absolute progress value (timer elapsed minutes), clamped to [0, target].
    func setProgress(_ habit: Habit, value: Double) {
        guard let d = def(habit.id) else { return }
        setValue(max(0, min(value, d.goalTarget)), for: d.id, day: HabitDay.today)
    }

    private func setValue(_ value: Double, for id: String, day: String) {
        var map = doc.logs[id] ?? [:]
        if value <= 0 { map.removeValue(forKey: day) } else { map[day] = value }
        doc.logs[id] = map
        persist()
    }

    // MARK: - CRUD

    func create(name: String, slot: HabitSlot, icon: String?, reminder: String?, freq: String = "daily",
                note: String? = nil, goal: HabitGoal = .check, target: Double = 1, unit: String? = nil, notify: Bool = true) {
        var d = HabitDef.new(name: name, slot: slot, icon: icon, reminder: reminder, freq: freq,
                             goal: goal, target: target, unit: unit, notify: notify, sort: nextSort)
        d.note = note
        doc.habits.append(d)
        persist()
    }

    func create(from t: HabitTemplate) {
        create(name: t.name, slot: t.slot, icon: t.icon, reminder: t.reminder,
               goal: t.goal, target: t.target, unit: t.unit)
    }

    /// Edit a habit. Changing the goal/target only affects FUTURE evaluation — the raw
    /// logged values in `doc.logs` are untouched, so history and analytics are preserved
    /// and today's progress is re-judged against the new target on the next render.
    func edit(_ id: String, apply: (inout HabitDef) -> Void) {
        guard let i = doc.habits.firstIndex(where: { $0.id == id }) else { return }
        apply(&doc.habits[i])
        persist()
    }

    func archive(_ habit: Habit, _ archived: Bool = true) { edit(habit.id) { $0.archived = archived } }
    func setNotify(_ habit: Habit, _ on: Bool) {
        edit(habit.id) { $0.notify = on }
        if !on { HabitNotifications.cancel(habit.id) }
    }

    func delete(_ habit: Habit) {
        doc.habits.removeAll { $0.id == habit.id }
        doc.logs.removeValue(forKey: habit.id)
        HabitNotifications.cancel(habit.id)
        persist()
    }

    // MARK: - persistence + backup

    /// Save locally (instant) and schedule a debounced background backup to the server.
    private func persist(backup: Bool = true) {
        HabitLocalStore.save(doc)
        HabitNotifications.reschedule(habits)
        objectWillChange.send()
        if backup { scheduleBackup() }
    }

    private func scheduleBackup() {
        backupTask?.cancel()
        let snapshot = doc
        backupTask = Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)   // debounce bursts of edits
            if Task.isCancelled { return }
            // back up under today's date — overwrites today's snapshot as it changes, so
            // there's one restore point per day (matches "saved to that day").
            try? await API.shared.putHabitBackup(day: HabitDay.today,
                                                 json: HabitLocalStore.snapshotJSON(snapshot))
        }
    }

    /// Force an immediate backup (used by a manual "Back up now").
    func backupNow() async {
        try? await API.shared.putHabitBackup(day: HabitDay.today, json: HabitLocalStore.snapshotJSON(doc))
    }

    /// Restore a backup snapshot, OVERWRITING the phone's current data.
    func restore(_ restored: HabitDoc) {
        doc = restored
        persist(backup: false)   // don't immediately re-backup a restore
    }
}

/// Timeline ordering of the slots: all-day first, then the CURRENT period, then the rest.
extension HabitSlot {
    static var currentPeriod: HabitSlot {
        switch Calendar.current.component(.hour, from: Date()) {
        case 5..<12:  return .morning
        case 12..<17: return .afternoon
        default:      return .evening
        }
    }
    var timelineRank: Int {
        if self == .allday { return 0 }
        if self == HabitSlot.currentPeriod { return 1 }
        let order: [HabitSlot] = [.morning, .afternoon, .evening]
        return 2 + (order.firstIndex(of: self) ?? 0)
    }
}
