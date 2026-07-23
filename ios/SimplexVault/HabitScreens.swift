import SwiftUI

// MARK: - Detail (reference screen 05)

/// One habit, closely: slot/meta, day streak, a last-30-days grid, and by-weekday bars.
struct HabitDetailView: View {
    @EnvironmentObject var habits: HabitStore
    @Environment(\.dismiss) private var dismiss
    let habitId: String

    private var habit: Habit? { habits.habits.first { $0.id == habitId } }

    var body: some View {
        ZStack {
            HabitTheme.cream.ignoresSafeArea()
            if let habit {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        streakCard(habit)
                        gridCard(habit)
                        weekdayCard(habit)
                        HStack(spacing: 12) {
                            actionButton(habit.archived ? "Unarchive" : "Archive", "archivebox") {
                                Task { await habits.archive(habit, !habit.archived); dismiss() }
                            }
                            actionButton("Delete", "trash", destructive: true) {
                                Task { await habits.delete(habit); dismiss() }
                            }
                        }
                        Color.clear.frame(height: 20)
                    }
                    .padding(20)
                }
            } else {
                Text("This habit was removed.").foregroundStyle(HabitTheme.inkSoft)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(habit?.name ?? "Habit").font(HabitTheme.serif(16, weight: .semibold)).foregroundStyle(HabitTheme.ink)
            }
        }
    }

    private func streakCard(_ h: Habit) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: habitIcon(h.icon)).font(.system(size: 16)).foregroundStyle(HabitTheme.terracotta)
                    .frame(width: 40, height: 40).background(HabitTheme.terracotta.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 1) {
                    Text("\(h.slotEnum.title.uppercased()) · \(h.freq == "daily" ? "EVERY DAY" : "WEEKDAYS")")
                        .font(HabitTheme.label(10)).foregroundStyle(HabitTheme.inkSoft)
                    if let note = h.note, !note.isEmpty {
                        Text(note).font(.system(size: 12)).foregroundStyle(HabitTheme.inkSoft)
                    }
                }
                Spacer()
            }
            HStack(alignment: .lastTextBaseline, spacing: 8) {
                Text("\(h.currentStreak)").font(HabitTheme.serif(52, weight: .bold)).foregroundStyle(HabitTheme.terracotta)
                VStack(alignment: .leading) {
                    Text("day streak").font(.system(size: 14, weight: .semibold)).foregroundStyle(HabitTheme.ink)
                    Text("Longest: \(h.longestStreak)").font(.system(size: 12)).foregroundStyle(HabitTheme.inkSoft)
                }
            }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(HabitTheme.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(HabitTheme.line))
    }

    private func gridCard(_ h: Habit) -> some View {
        let days = HabitDay.lastDays(30)
        let done = h.completionDays
        let doneCount = days.filter { done.contains($0) }.count
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Last 30 days").font(.system(size: 13, weight: .semibold)).foregroundStyle(HabitTheme.ink)
                Spacer()
                Text("\(doneCount) of 30").font(SimplexTheme.mono(11)).foregroundStyle(HabitTheme.inkSoft)
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 10), spacing: 6) {
                ForEach(days, id: \.self) { day in
                    RoundedRectangle(cornerRadius: 4)
                        .fill(done.contains(day) ? HabitTheme.terracotta : HabitTheme.line.opacity(0.6))
                        .aspectRatio(1, contentMode: .fit)
                        .overlay(day == HabitDay.today ? RoundedRectangle(cornerRadius: 4).stroke(HabitTheme.ink, lineWidth: 1.5) : nil)
                }
            }
        }
        .padding(16)
        .background(HabitTheme.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(HabitTheme.line))
    }

    private func weekdayCard(_ h: Habit) -> some View {
        // count completions per weekday (Mon…Sun)
        var counts = [Int](repeating: 0, count: 7)
        for d in h.completionDays {
            if let date = HabitDay.date(d) {
                let wd = (Calendar.current.component(.weekday, from: date) + 5) % 7  // Mon=0
                counts[wd] += 1
            }
        }
        let maxC = max(counts.max() ?? 1, 1)
        let bestIdx = counts.firstIndex(of: counts.max() ?? 0) ?? 0
        let labels = ["M","T","W","T","F","S","S"]
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("By weekday").font(.system(size: 13, weight: .semibold)).foregroundStyle(HabitTheme.ink)
                Spacer()
                Text("\(labels[bestIdx]) is your best").font(SimplexTheme.mono(10)).foregroundStyle(HabitTheme.inkSoft)
            }
            HStack(alignment: .bottom, spacing: 8) {
                ForEach(0..<7, id: \.self) { i in
                    VStack(spacing: 4) {
                        RoundedRectangle(cornerRadius: 4)
                            .fill(i == bestIdx ? HabitTheme.terracotta : HabitTheme.terraSoft.opacity(0.5))
                            .frame(height: 12 + CGFloat(counts[i]) / CGFloat(maxC) * 52)
                        Text(labels[i]).font(SimplexTheme.mono(10)).foregroundStyle(HabitTheme.inkSoft)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .padding(16)
        .background(HabitTheme.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(HabitTheme.line))
    }

    private func actionButton(_ title: String, _ icon: String, destructive: Bool = false, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon).font(.system(size: 14, weight: .medium))
                .foregroundStyle(destructive ? Color.red : HabitTheme.ink)
                .frame(maxWidth: .infinity).padding(.vertical, 12)
                .background(HabitTheme.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(HabitTheme.line))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Templates (reference screen 02)

struct HabitTemplatesView: View {
    @EnvironmentObject var habits: HabitStore
    @State private var showAdd = false
    private let cols = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        ZStack {
            HabitTheme.cream.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("What do you\nwant to build?")
                            .font(HabitTheme.serif(28, weight: .bold)).foregroundStyle(HabitTheme.ink)
                        Text("Start with one. You can always add more.")
                            .font(.system(size: 13)).foregroundStyle(HabitTheme.inkSoft)
                    }
                    LazyVGrid(columns: cols, spacing: 12) {
                        ForEach(HabitTemplate.all) { t in
                            Button { Task { await habits.create(from: t) } } label: { TemplateCard(template: t) }
                                .buttonStyle(.plain)
                        }
                    }
                    Button { showAdd = true } label: {
                        Text("Or create your own")
                            .font(.system(size: 14, weight: .semibold)).foregroundStyle(HabitTheme.terracotta)
                            .frame(maxWidth: .infinity)
                    }
                    .padding(.top, 4)
                    Color.clear.frame(height: 30)
                }
                .padding(20)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .principal) { Text("Templates").font(HabitTheme.serif(16, weight: .semibold)).foregroundStyle(HabitTheme.ink) } }
        .sheet(isPresented: $showAdd) { HabitAddSheet().environmentObject(habits) }
    }
}

private struct TemplateCard: View {
    let template: HabitTemplate
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: habitIcon(template.icon)).font(.system(size: 16)).foregroundStyle(HabitTheme.terracotta)
                .frame(width: 38, height: 38).background(HabitTheme.terracotta.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
            Text(template.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(HabitTheme.ink).lineLimit(1)
            Text(template.detail).font(.system(size: 12)).foregroundStyle(HabitTheme.inkSoft).lineLimit(1)
        }
        .padding(14).frame(maxWidth: .infinity, minHeight: 120, alignment: .leading)
        .background(HabitTheme.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(HabitTheme.line))
    }
}

// MARK: - Insights (reference screen 08)

struct HabitInsightsView: View {
    @EnvironmentObject var habits: HabitStore
    @Environment(\.dismiss) private var dismiss

    private var totalCompletions: Int { habits.habits.reduce(0) { $0 + ($1.days?.count ?? 0) } }
    private var longest: (Int, String) {
        let best = habits.habits.max { ($0.longestStreak) < ($1.longestStreak) }
        return (best?.longestStreak ?? 0, best?.name ?? "—")
    }

    var body: some View {
        ZStack {
            HabitTheme.cream.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("INSIGHTS").font(HabitTheme.label(11)).tracking(1.5).foregroundStyle(HabitTheme.inkSoft)
                    HStack(spacing: 12) {
                        statCard("COMPLETIONS", "\(totalCompletions)", sub: "all time", dark: false)
                        statCard("LONGEST STREAK", "\(longest.0)", sub: longest.1, dark: true)
                    }
                    whereWins
                    Color.clear.frame(height: 20)
                }
                .padding(20)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { Text("Insights").font(HabitTheme.serif(16, weight: .semibold)).foregroundStyle(HabitTheme.ink) }
            ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() }.foregroundStyle(HabitTheme.terracotta) }
        }
    }

    private func statCard(_ title: String, _ value: String, sub: String, dark: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(HabitTheme.label(10)).foregroundStyle(dark ? HabitTheme.cream.opacity(0.7) : HabitTheme.inkSoft)
            Text(value).font(HabitTheme.serif(34, weight: .bold)).foregroundStyle(dark ? HabitTheme.cream : HabitTheme.ink)
            Text(sub).font(.system(size: 11)).foregroundStyle(dark ? HabitTheme.cream.opacity(0.7) : HabitTheme.inkSoft).lineLimit(1)
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(dark ? HabitTheme.terracotta : HabitTheme.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(dark ? nil : RoundedRectangle(cornerRadius: 16).stroke(HabitTheme.line))
    }

    private var whereWins: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Where the wins happen").font(.system(size: 13, weight: .semibold)).foregroundStyle(HabitTheme.ink)
            ForEach(HabitSlot.allCases) { slot in
                let count = habits.habits.filter { $0.slotEnum == slot }.reduce(0) { $0 + ($1.days?.count ?? 0) }
                let maxCount = max(HabitSlot.allCases.map { s in habits.habits.filter { $0.slotEnum == s }.reduce(0) { $0 + ($1.days?.count ?? 0) } }.max() ?? 1, 1)
                HStack(spacing: 10) {
                    Text(slot.title).font(.system(size: 12)).foregroundStyle(HabitTheme.inkSoft).frame(width: 72, alignment: .leading)
                    GeometryReader { geo in
                        Capsule().fill(HabitTheme.terracotta)
                            .frame(width: max(4, geo.size.width * CGFloat(count) / CGFloat(maxCount)))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }.frame(height: 8)
                    Text("\(count)").font(SimplexTheme.mono(11)).foregroundStyle(HabitTheme.inkSoft).frame(width: 34, alignment: .trailing)
                }
            }
        }
        .padding(16)
        .background(HabitTheme.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(HabitTheme.line))
    }
}

// MARK: - Weekly review (reference screen 07)

struct HabitReviewView: View {
    @EnvironmentObject var habits: HabitStore

    // completions in the last 7 days as a % of possible
    private var week: [String] { HabitDay.lastDays(7) }
    private var kept: Int {
        let set = Set(week)
        return habits.habits.reduce(0) { acc, h in acc + h.completionDays.filter { set.contains($0) }.count }
    }
    private var possible: Int { habits.activeHabits.count * 7 }
    private var percent: Int { possible == 0 ? 0 : Int(Double(kept) / Double(possible) * 100) }

    var body: some View {
        ZStack {
            HabitTheme.cream.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("This week").font(HabitTheme.label(11)).tracking(1.5).foregroundStyle(HabitTheme.inkSoft)
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text("\(percent)").font(HabitTheme.serif(64, weight: .bold)).foregroundStyle(HabitTheme.ink)
                        Text("%").font(HabitTheme.serif(28, weight: .bold)).foregroundStyle(HabitTheme.terracotta)
                    }
                    Text("of habits kept this week.").font(.system(size: 14)).foregroundStyle(HabitTheme.inkSoft)

                    // daily completion bars
                    dailyBars
                    Color.clear.frame(height: 20)
                }
                .padding(20)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .principal) { Text("Weekly review").font(HabitTheme.serif(16, weight: .semibold)).foregroundStyle(HabitTheme.ink) } }
    }

    private var dailyBars: some View {
        let labels = ["M","T","W","T","F","S","S"]
        let counts: [Int] = week.map { day in habits.habits.filter { $0.completionDays.contains(day) }.count }
        let maxC = max(counts.max() ?? 1, 1)
        return VStack(alignment: .leading, spacing: 10) {
            Text("DAILY COMPLETION").font(HabitTheme.label(10)).foregroundStyle(HabitTheme.inkSoft)
            HStack(alignment: .bottom, spacing: 8) {
                ForEach(0..<7, id: \.self) { i in
                    VStack(spacing: 4) {
                        RoundedRectangle(cornerRadius: 4).fill(HabitTheme.terracotta.opacity(i == 6 ? 1 : 0.8))
                            .frame(height: 12 + CGFloat(counts[i]) / CGFloat(maxC) * 90)
                        Text(labels[i]).font(SimplexTheme.mono(10)).foregroundStyle(HabitTheme.inkSoft)
                    }.frame(maxWidth: .infinity)
                }
            }
        }
        .padding(16).background(HabitTheme.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(HabitTheme.line))
    }
}

// MARK: - Onboarding (reference screen 01) + Celebration (screen 04)

struct HabitOnboardingView: View {
    @EnvironmentObject var habits: HabitStore
    @Environment(\.dismiss) private var dismiss
    @State private var page = 0

    var body: some View {
        ZStack {
            LinearGradient(colors: [HabitTheme.cream, Color(hex: 0xe9c9b8)], startPoint: .top, endPoint: .bottom).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    HStack(spacing: 8) {
                        Text("h").font(HabitTheme.serif(18, italic: true)).foregroundStyle(HabitTheme.cream)
                            .frame(width: 30, height: 30).background(HabitTheme.charcoal, in: RoundedRectangle(cornerRadius: 8))
                        Text("HABIT").font(HabitTheme.label(13)).tracking(2).foregroundStyle(HabitTheme.ink)
                    }
                    Spacer()
                }
                Spacer()
                Text("Small things,\ndone daily.")
                    .font(HabitTheme.serif(40, weight: .bold)).foregroundStyle(HabitTheme.ink)
                Text("A quiet home for the rituals that build the rest of your life.")
                    .font(.system(size: 15)).foregroundStyle(HabitTheme.inkSoft).padding(.top, 12)
                Spacer()
                Button { dismiss() } label: {
                    Text("Begin").font(.system(size: 17, weight: .semibold)).foregroundStyle(HabitTheme.cream)
                        .frame(maxWidth: .infinity).padding(.vertical, 17)
                        .background(HabitTheme.charcoal, in: Capsule())
                }
                Button { dismiss() } label: {
                    Text("I already have habits →").font(.system(size: 14)).foregroundStyle(HabitTheme.inkSoft)
                        .frame(maxWidth: .infinity).padding(.top, 12)
                }
            }
            .padding(28)
        }
    }
}

/// The "Today, complete" celebration when every habit is done (reference screen 04).
struct HabitCelebrationView: View {
    @EnvironmentObject var habits: HabitStore
    var body: some View {
        ZStack {
            HabitTheme.terracotta.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 14) {
                Text("TODAY, ALL DONE").font(HabitTheme.label(11)).tracking(1.5).foregroundStyle(HabitTheme.cream.opacity(0.8))
                Text("Nice —\nthat's the\nwhole list.")
                    .font(HabitTheme.serif(44, weight: .bold)).foregroundStyle(HabitTheme.cream)
                Text("\(habits.totalCount) small things, done. Rest well. Tomorrow starts fresh at midnight.")
                    .font(.system(size: 15)).foregroundStyle(HabitTheme.cream.opacity(0.9)).padding(.top, 4)
                Spacer()
            }
            .padding(28).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
