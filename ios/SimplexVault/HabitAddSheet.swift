import SwiftUI

/// The habit editor bottom sheet — creates a new habit, or edits an existing one
/// (`editing:`). Editing changes FUTURE behavior only; past completion history is left
/// untouched by the server. Includes the goal type (Simple / Count / Timer), target, and
/// unit so a habit can be measured (e.g. 8 glasses, 20 min).
struct HabitAddSheet: View {
    @EnvironmentObject var habits: HabitStore
    @Environment(\.dismiss) private var dismiss

    /// nil = create; non-nil = edit that habit.
    var editing: Habit? = nil

    @State private var icon = "water"
    @State private var name = ""
    @State private var slot: HabitSlot = .morning
    @State private var everyDay = true
    @State private var reminderOn = false
    @State private var reminder = Date()
    @State private var goal: HabitGoal = .check
    @State private var target = 8
    @State private var unit = ""
    @State private var didPrefill = false

    private var isEdit: Bool { editing != nil }

    var body: some View {
        ZStack {
            HabitTheme.cream.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack {
                        Text(isEdit ? "Edit habit" : "New habit")
                            .font(HabitTheme.serif(26, weight: .bold)).foregroundStyle(HabitTheme.ink)
                        Spacer()
                        Button("Save", action: save)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(name.isEmpty ? HabitTheme.inkSoft : HabitTheme.terracotta)
                            .disabled(name.isEmpty)
                    }

                    // icon row
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(HABIT_ICON_KEYS, id: \.self) { key in
                                Button { icon = key } label: {
                                    Image(systemName: habitIcon(key))
                                        .font(.system(size: 17))
                                        .foregroundStyle(icon == key ? .white : HabitTheme.ink)
                                        .frame(width: 44, height: 44)
                                        .background(icon == key ? HabitTheme.terracotta : HabitTheme.card, in: RoundedRectangle(cornerRadius: 12))
                                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(HabitTheme.line))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    field("NAME") {
                        TextField("Drink water", text: $name)
                            .font(.system(size: 16)).foregroundStyle(HabitTheme.ink)
                    }

                    // goal type
                    VStack(alignment: .leading, spacing: 8) {
                        Text("GOAL").font(HabitTheme.label(10)).tracking(1).foregroundStyle(HabitTheme.inkSoft)
                        HStack(spacing: 8) {
                            ForEach(HabitGoal.allCases) { g in
                                Button { goal = g; if unit.isEmpty { unit = g.defaultUnit } } label: {
                                    Label(g.title, systemImage: g.icon).font(.system(size: 13, weight: .medium))
                                        .foregroundStyle(goal == g ? .white : HabitTheme.ink)
                                        .padding(.horizontal, 12).padding(.vertical, 9)
                                        .background(goal == g ? HabitTheme.terracotta : HabitTheme.card, in: Capsule())
                                        .overlay(Capsule().stroke(HabitTheme.line))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        // target + unit for count/timer goals
                        if goal != .check {
                            HStack(spacing: 12) {
                                field(goal == .timer ? "MINUTES" : "TARGET") {
                                    HStack {
                                        Stepper(value: $target, in: 1...999) {
                                            Text("\(target)").font(.system(size: 15, weight: .semibold)).foregroundStyle(HabitTheme.ink)
                                        }.tint(HabitTheme.terracotta)
                                    }
                                }
                                if goal == .count {
                                    field("UNIT") {
                                        TextField("glasses", text: $unit)
                                            .font(.system(size: 15)).foregroundStyle(HabitTheme.ink)
                                    }
                                }
                            }
                        }
                    }

                    // when (slot)
                    VStack(alignment: .leading, spacing: 8) {
                        Text("WHEN").font(HabitTheme.label(10)).tracking(1).foregroundStyle(HabitTheme.inkSoft)
                        HStack(spacing: 8) {
                            ForEach(HabitSlot.allCases) { s in
                                Button { slot = s } label: {
                                    Text(s.title).font(.system(size: 13, weight: .medium))
                                        .foregroundStyle(slot == s ? .white : HabitTheme.ink)
                                        .padding(.horizontal, 12).padding(.vertical, 8)
                                        .background(slot == s ? HabitTheme.terracotta : HabitTheme.card, in: Capsule())
                                        .overlay(Capsule().stroke(HabitTheme.line))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    HStack(spacing: 12) {
                        field("FREQUENCY") {
                            Menu {
                                Button("Every day") { everyDay = true }
                                Button("Weekdays") { everyDay = false }
                            } label: {
                                Text(everyDay ? "Every day" : "Weekdays")
                                    .font(.system(size: 15)).foregroundStyle(HabitTheme.ink)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        field("REMINDER") {
                            if reminderOn {
                                DatePicker("", selection: $reminder, displayedComponents: .hourAndMinute)
                                    .labelsHidden().tint(HabitTheme.terracotta)
                            } else {
                                Button("Period default") { reminderOn = true }
                                    .font(.system(size: 14)).foregroundStyle(HabitTheme.inkSoft)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }

                    Button(action: save) {
                        Text(isEdit ? "Save changes" : "Create habit").font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 15)
                            .background(name.isEmpty ? HabitTheme.terraSoft : HabitTheme.terracotta, in: Capsule())
                    }
                    .disabled(name.isEmpty)
                    .padding(.top, 4)
                }
                .padding(20)
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .onAppear(perform: prefill)
    }

    @ViewBuilder
    private func field<Content: View>(_ label: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(HabitTheme.label(10)).tracking(1).foregroundStyle(HabitTheme.inkSoft)
            content()
                .padding(.horizontal, 12).padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(HabitTheme.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(HabitTheme.line))
        }
    }

    private func prefill() {
        guard let h = editing, !didPrefill else { return }
        didPrefill = true
        icon = h.icon ?? "water"
        name = h.name
        slot = h.slotEnum
        everyDay = h.freq != "weekdays"
        goal = h.goal
        target = Int(h.target)
        unit = h.unit ?? ""
        if let r = h.reminder, let d = timeFrom(r) { reminderOn = true; reminder = d }
    }

    private func save() {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty else { return }
        let rem: String? = reminderOn ? {
            let f = DateFormatter(); f.dateFormat = "HH:mm"; return f.string(from: reminder)
        }() : nil
        let unitVal = goal == .check ? nil : (unit.isEmpty ? goal.defaultUnit : unit)
        let tgt = goal == .check ? 1.0 : Double(target)

        if let h = editing {
            // Edit is LOCAL and instant. Editing the goal only changes future evaluation —
            // the logged daily values are untouched, so past history is preserved.
            habits.edit(h.id) { d in
                d.name = n; d.icon = icon; d.slot = slot.rawValue
                d.freq = everyDay ? "daily" : "weekdays"
                d.goalType = goal.rawValue; d.goalTarget = tgt
                d.reminder = rem; d.unit = unitVal
            }
        } else {
            habits.create(name: n, slot: slot, icon: icon, reminder: rem,
                          freq: everyDay ? "daily" : "weekdays",
                          goal: goal, target: tgt, unit: unitVal)
        }
        dismiss()
    }

    private func timeFrom(_ s: String) -> Date? {
        let f = DateFormatter(); f.dateFormat = "HH:mm"; return f.date(from: s)
    }
}
