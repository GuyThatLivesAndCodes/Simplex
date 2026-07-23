import Foundation
import SwiftUI

/// State for the Habit system: the user's habits, loading, and mutations. Talks to the
/// server-backed Habit API so data syncs across devices.
@MainActor
final class HabitStore: ObservableObject {
    @Published var habits: [Habit] = []
    @Published var loaded = false
    @Published var error: String?
    /// The day we last showed the "all done" celebration, so it fires at most once per
    /// day even as views rebuild. Lives on the store (which persists across system
    /// switches) rather than transient view @State.
    var celebratedForDay = ""

    /// Habits that show on Today (non-archived), grouped by slot in display order.
    func habits(in slot: HabitSlot) -> [Habit] {
        habits.filter { !$0.archived && $0.slotEnum == slot }
              .sorted { $0.sort < $1.sort }
    }

    var activeHabits: [Habit] { habits.filter { !$0.archived }.sorted { $0.sort < $1.sort } }
    var archivedHabits: [Habit] { habits.filter { $0.archived } }

    /// Slots that have habits, ordered as a TIMELINE: all-day pinned on top, then the
    /// current time-of-day period, then the rest — so "now" is always near the top.
    var visibleSlots: [HabitSlot] {
        HabitSlot.allCases
            .filter { !habits(in: $0).isEmpty }
            .sorted { $0.timelineRank < $1.timelineRank }
    }

    // today's progress
    var doneCount: Int { activeHabits.filter { $0.isDoneToday }.count }
    var totalCount: Int { activeHabits.count }
    var allDone: Bool { totalCount > 0 && doneCount == totalCount }
    var fractionDone: Double { totalCount == 0 ? 0 : Double(doneCount) / Double(totalCount) }

    func doneCount(in slot: HabitSlot) -> Int { habits(in: slot).filter { $0.isDoneToday }.count }

    // MARK: - load / mutate

    func load() async {
        do {
            habits = try await API.shared.listHabits(today: HabitDay.today)
            loaded = true
            error = nil
            HabitNotifications.reschedule(habits)   // keep reminders in sync with state
        } catch {
            self.error = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Toggle done/undone (used by check habits + the slide-to-complete gesture). For a
    /// goal habit, this jumps straight to complete (or clears it).
    func toggle(_ habit: Habit) async {
        let day = HabitDay.today
        // optimistic flip so the UI responds instantly
        if let i = habits.firstIndex(where: { $0.id == habit.id }) {
            let nowDone = !(habits[i].doneToday ?? false)
            habits[i].doneToday = nowDone
            habits[i].todayValue = nowDone ? habits[i].target : 0
        }
        do { replace(try await API.shared.logHabit(id: habit.id, day: day, today: day, done: !(habit.doneToday ?? false))) }
        catch { await load() }
    }

    /// Force-complete a habit (slide-to-confirm).
    func complete(_ habit: Habit) async {
        let day = HabitDay.today
        if let i = habits.firstIndex(where: { $0.id == habit.id }) { habits[i].doneToday = true; habits[i].todayValue = habits[i].target }
        do { replace(try await API.shared.logHabit(id: habit.id, day: day, today: day, done: true)) }
        catch { await load() }
    }

    /// Add to a counter/timer habit's progress today (e.g. +1 glass, +60s).
    func add(_ habit: Habit, delta: Double) async {
        let day = HabitDay.today
        do { replace(try await API.shared.logHabit(id: habit.id, day: day, today: day, delta: delta)) }
        catch { await load() }
    }

    /// Set an absolute progress value today (e.g. timer elapsed minutes).
    func setProgress(_ habit: Habit, value: Double) async {
        let day = HabitDay.today
        do { replace(try await API.shared.logHabit(id: habit.id, day: day, today: day, value: value)) }
        catch { await load() }
    }

    func create(name: String, slot: HabitSlot, icon: String?, reminder: String?, freq: String = "daily",
                note: String? = nil, goal: HabitGoal = .check, target: Double = 1, unit: String? = nil, notify: Bool = true) async {
        do {
            let h = try await API.shared.createHabit(name: name, slot: slot.rawValue, icon: icon, freq: freq,
                                                     reminder: reminder, note: note, goalType: goal.rawValue,
                                                     goalTarget: target, unit: unit, notify: notify)
            habits.append(h)
            HabitNotifications.reschedule(habits)
        } catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
    }

    func create(from template: HabitTemplate) async {
        await create(name: template.name, slot: template.slot, icon: template.icon, reminder: template.reminder,
                     goal: template.goal, target: template.target, unit: template.unit)
    }

    func update(_ habit: Habit, changes: [String: Any]) async {
        do { replace(try await API.shared.updateHabit(id: habit.id, changes: changes)); HabitNotifications.reschedule(habits) }
        catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
    }

    func archive(_ habit: Habit, _ archived: Bool = true) async {
        await update(habit, changes: ["archived": archived])
    }

    func setNotify(_ habit: Habit, _ on: Bool) async {
        await update(habit, changes: ["notify": on])
    }

    func delete(_ habit: Habit) async {
        do { try await API.shared.deleteHabit(id: habit.id); habits.removeAll { $0.id == habit.id }; HabitNotifications.reschedule(habits) }
        catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
    }

    private func replace(_ h: Habit) {
        if let i = habits.firstIndex(where: { $0.id == h.id }) { habits[i] = h }
        else { habits.append(h) }
    }
}

/// Timeline ordering of the slots: all-day is always first, then the CURRENT period, then
/// the rest in natural order. Used by Today so "now" floats to the top.
extension HabitSlot {
    static var currentPeriod: HabitSlot {
        switch Calendar.current.component(.hour, from: Date()) {
        case 5..<12:  return .morning
        case 12..<17: return .afternoon
        default:      return .evening
        }
    }
    /// Sort key for the timeline (lower = higher on screen).
    var timelineRank: Int {
        if self == .allday { return 0 }
        if self == HabitSlot.currentPeriod { return 1 }
        // remaining periods keep chronological order after the current one
        let order: [HabitSlot] = [.morning, .afternoon, .evening]
        return 2 + (order.firstIndex(of: self) ?? 0)
    }
}
