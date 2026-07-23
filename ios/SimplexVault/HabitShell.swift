import SwiftUI

/// The Habit system's tab shell. Per the product decision, its bottom tabs are
/// **Habits** and **Templates** (Account is shared across systems, added here too so the
/// user can still reach it). The Habits tab hosts Today, with Insights and the weekly
/// Review reachable from it.
struct HabitShell: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var habits: HabitStore   // owned by AppShell, survives system switches
    @State private var tab = 0
    @State private var showOnboarding = false

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack { HabitTodayView().withSystemSwitcher() }
                .tabItem { Label("Habits", systemImage: "checkmark.circle") }.tag(0)
            NavigationStack { HabitTemplatesView().withSystemSwitcher() }
                .tabItem { Label("Templates", systemImage: "square.grid.2x2") }.tag(1)
            NavigationStack { AccountView() }
                .tabItem { Label("Account", systemImage: "person") }.tag(2)
        }
        .task {
            // Load once per session. Only offer onboarding after a SUCCESSFUL load that
            // truly returned zero habits — never on a transient/failed load (that's what
            // made habits look "deleted" and popped onboarding on return).
            if !habits.loaded { await habits.load() }
            if habits.loaded && habits.error == nil && habits.habits.isEmpty { showOnboarding = true }
        }
        .fullScreenCover(isPresented: $showOnboarding) {
            HabitOnboardingView().environmentObject(habits)
        }
    }
}

// MARK: - Today

/// Screen 03/04 in the reference: date header, progress banner, and the habits grouped
/// into Morning / Afternoon / Evening / All-day sections with tap-to-complete.
struct HabitTodayView: View {
    @EnvironmentObject var habits: HabitStore
    @State private var showAdd = false
    @State private var showInsights = false
    @State private var showCelebration = false

    var body: some View {
        ZStack {
            HabitTheme.cream.ignoresSafeArea()
            // The Today list is ALWAYS present (so it's never a dead end — you can always
            // see and un-check habits). The celebration is a dismissible overlay.
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    header
                    progressBanner
                    ForEach(habits.visibleSlots) { slot in
                        slotSection(slot)
                    }
                    if habits.totalCount == 0 {
                        emptyPrompt
                    }
                    Color.clear.frame(height: 40)
                }
                .padding(20)
            }
        }
        // celebrate once per day when the last habit of the day gets checked off
        .onChange(of: habits.allDone) { done in
            if done && habits.totalCount > 0 && habits.celebratedForDay != HabitDay.today {
                habits.celebratedForDay = HabitDay.today
                showCelebration = true
            }
        }
        .fullScreenCover(isPresented: $showCelebration) {
            HabitCelebrationView { showCelebration = false }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text("Today").font(HabitTheme.serif(17, weight: .semibold)).foregroundStyle(HabitTheme.ink)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { showAdd = true } label: { Label("New habit", systemImage: "plus") }
                    Button { showInsights = true } label: { Label("Insights", systemImage: "chart.bar") }
                    NavigationLink { HabitReviewView() } label: { Label("Weekly review", systemImage: "calendar") }
                } label: { Image(systemName: "ellipsis.circle").foregroundStyle(HabitTheme.terracotta) }
            }
        }
        .sheet(isPresented: $showAdd) { HabitAddSheet().environmentObject(habits) }
        .sheet(isPresented: $showInsights) { NavigationStack { HabitInsightsView() }.environmentObject(habits) }
        .refreshable { await habits.load() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(weekdayName.uppercased())
                .font(HabitTheme.label()).tracking(1.5).foregroundStyle(HabitTheme.inkSoft)
            Text(monthDay)
                .font(HabitTheme.serif(34, weight: .bold)).foregroundStyle(HabitTheme.ink)
        }
    }

    private var progressBanner: some View {
        HStack(spacing: 14) {
            ProgressRing(fraction: habits.fractionDone, label: "\(habits.doneCount)")
                .frame(width: 46, height: 46)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(habits.doneCount) of \(habits.totalCount) done — \(paceText)")
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(HabitTheme.ink)
                Text(subText).font(.system(size: 12)).foregroundStyle(HabitTheme.inkSoft)
            }
            Spacer()
        }
        .padding(14)
        .background(HabitTheme.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(HabitTheme.line))
    }

    @ViewBuilder
    private func slotSection(_ slot: HabitSlot) -> some View {
        let items = habits.habits(in: slot)
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(slot.title.uppercased()).font(HabitTheme.label()).tracking(1).foregroundStyle(HabitTheme.inkSoft)
                Spacer()
                Text("\(habits.doneCount(in: slot))/\(items.count) done")
                    .font(SimplexTheme.mono(10)).foregroundStyle(HabitTheme.inkSoft)
            }
            VStack(spacing: 0) {
                ForEach(items) { habit in
                    NavigationLink { HabitDetailView(habitId: habit.id) } label: {
                        HabitRow(habit: habit) { Task { await habits.toggle(habit) } }
                    }
                    .buttonStyle(.plain)
                    if habit.id != items.last?.id { Divider().background(HabitTheme.line).padding(.leading, 44) }
                }
            }
            .padding(.vertical, 4)
            .background(HabitTheme.card, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(HabitTheme.line))
        }
    }

    private var emptyPrompt: some View {
        VStack(spacing: 10) {
            Text("No habits yet").font(HabitTheme.serif(20, weight: .semibold)).foregroundStyle(HabitTheme.ink)
            Button { showAdd = true } label: {
                Text("Add your first").font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 20).padding(.vertical, 12)
                    .background(HabitTheme.terracotta, in: Capsule())
            }
        }
        .frame(maxWidth: .infinity).padding(.top, 30)
    }

    // header text
    private var weekdayName: String { let f = DateFormatter(); f.dateFormat = "EEEE"; return f.string(from: Date()) }
    private var monthDay: String { let f = DateFormatter(); f.dateFormat = "MMMM d"; return f.string(from: Date()) }
    private var paceText: String {
        switch habits.fractionDone {
        case 1: return "all done"
        case 0.66...: return "nice pace"
        case 0.33..<0.66: return "keep going"
        default: return "let's begin"
        }
    }
    private var subText: String {
        let hour = Calendar.current.component(.hour, from: Date())
        if habits.allDone { return "Rest well. Tomorrow starts fresh at midnight." }
        return hour < 18 ? "Plenty of day left. You've got this." : "Evening left. You've got this."
    }
}

/// One habit row on Today: a check circle, name (struck through when done), and its
/// streak count on the right (like the reference's small number).
struct HabitRow: View {
    let habit: Habit
    let onToggle: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Button(action: onToggle) {
                Image(systemName: habit.isDoneToday ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22))
                    .foregroundStyle(habit.isDoneToday ? HabitTheme.done : HabitTheme.inkSoft.opacity(0.5))
            }
            .buttonStyle(.plain)
            VStack(alignment: .leading, spacing: 1) {
                Text(habit.name)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(habit.isDoneToday ? HabitTheme.inkSoft : HabitTheme.ink)
                    .strikethrough(habit.isDoneToday, color: HabitTheme.inkSoft)
                if let reminder = habit.reminder, !habit.isDoneToday {
                    Text("Reminder · \(reminder)").font(.system(size: 11)).foregroundStyle(HabitTheme.inkSoft)
                }
            }
            Spacer()
            if habit.currentStreak > 0 {
                Text("\(habit.currentStreak)")
                    .font(HabitTheme.serif(15, italic: true)).foregroundStyle(HabitTheme.terracotta)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .contentShape(Rectangle())
    }
}

/// A small circular progress ring with a centered number (the reference's banner ring).
struct ProgressRing: View {
    let fraction: Double
    let label: String
    var body: some View {
        ZStack {
            Circle().stroke(HabitTheme.line, lineWidth: 4)
            Circle().trim(from: 0, to: max(0.001, fraction))
                .stroke(HabitTheme.terracotta, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text(label).font(.system(size: 15, weight: .semibold)).foregroundStyle(HabitTheme.ink)
        }
    }
}
