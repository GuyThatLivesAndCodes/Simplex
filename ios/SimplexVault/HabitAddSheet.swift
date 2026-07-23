import SwiftUI

/// The "New habit" bottom sheet (reference screen 06): icon row, name, when (slot),
/// frequency, reminder, and a Create button.
struct HabitAddSheet: View {
    @EnvironmentObject var habits: HabitStore
    @Environment(\.dismiss) private var dismiss

    @State private var icon = "water"
    @State private var name = ""
    @State private var slot: HabitSlot = .morning
    @State private var everyDay = true
    @State private var reminderOn = false
    @State private var reminder = Date()

    var body: some View {
        ZStack {
            HabitTheme.cream.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack {
                        Text("New habit").font(HabitTheme.serif(26, weight: .bold)).foregroundStyle(HabitTheme.ink)
                        Spacer()
                        Button("Save", action: create)
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
                                        .foregroundStyle(icon == key ? HabitTheme.cream : HabitTheme.ink)
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

                    // when (slot)
                    VStack(alignment: .leading, spacing: 8) {
                        Text("WHEN").font(HabitTheme.label(10)).tracking(1).foregroundStyle(HabitTheme.inkSoft)
                        HStack(spacing: 8) {
                            ForEach(HabitSlot.allCases) { s in
                                Button { slot = s } label: {
                                    Text(s.title).font(.system(size: 13, weight: .medium))
                                        .foregroundStyle(slot == s ? HabitTheme.cream : HabitTheme.ink)
                                        .padding(.horizontal, 12).padding(.vertical, 8)
                                        .background(slot == s ? HabitTheme.charcoal : HabitTheme.card, in: Capsule())
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
                                Button("Off") { reminderOn = true }
                                    .font(.system(size: 15)).foregroundStyle(HabitTheme.inkSoft)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }

                    Button(action: create) {
                        Text("Create habit").font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(HabitTheme.cream)
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

    private func create() {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty else { return }
        let rem: String? = reminderOn ? {
            let f = DateFormatter(); f.dateFormat = "HH:mm"; return f.string(from: reminder)
        }() : nil
        Task {
            await habits.create(name: n, slot: slot, icon: icon, reminder: rem, freq: everyDay ? "daily" : "weekdays")
            dismiss()
        }
    }
}
