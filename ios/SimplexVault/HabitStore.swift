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

    /// A slot only shows on Today if it has at least one habit.
    var visibleSlots: [HabitSlot] {
        HabitSlot.allCases.filter { !habits(in: $0).isEmpty }
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
        } catch {
            self.error = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    func toggle(_ habit: Habit) async {
        // optimistic flip so the checkmark responds instantly
        let day = HabitDay.today
        if let i = habits.firstIndex(where: { $0.id == habit.id }) {
            habits[i].doneToday = !(habits[i].doneToday ?? false)
        }
        do {
            let updated = try await API.shared.toggleHabit(id: habit.id, day: day, today: day, done: nil)
            replace(updated)
        } catch {
            await load()   // reconcile on failure
        }
    }

    func create(name: String, slot: HabitSlot, icon: String?, reminder: String?, freq: String = "daily", note: String? = nil) async {
        do {
            let h = try await API.shared.createHabit(name: name, slot: slot.rawValue, icon: icon, freq: freq, reminder: reminder, note: note)
            habits.append(h)
        } catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
    }

    func create(from template: HabitTemplate) async {
        await create(name: template.name, slot: template.slot, icon: template.icon, reminder: template.reminder)
    }

    func update(_ habit: Habit, changes: [String: Any]) async {
        do { replace(try await API.shared.updateHabit(id: habit.id, changes: changes)) }
        catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
    }

    func archive(_ habit: Habit, _ archived: Bool = true) async {
        await update(habit, changes: ["archived": archived])
    }

    func delete(_ habit: Habit) async {
        do { try await API.shared.deleteHabit(id: habit.id); habits.removeAll { $0.id == habit.id } }
        catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
    }

    private func replace(_ h: Habit) {
        if let i = habits.firstIndex(where: { $0.id == h.id }) { habits[i] = h }
        else { habits.append(h) }
    }
}
