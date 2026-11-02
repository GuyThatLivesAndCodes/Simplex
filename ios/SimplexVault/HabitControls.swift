import SwiftUI

/// A "slide to confirm" bar — drag the knob to the end to trigger `onConfirm`. The
/// engaging, deliberate way to complete a habit. Resets if released before the end.
struct SlideToConfirm: View {
    var title: String = "Slide to complete"
    var tint: Color = HabitTheme.terracotta
    var onConfirm: () -> Void

    @State private var offset: CGFloat = 0
    @State private var confirmed = false
    private let knob: CGFloat = 52

    var body: some View {
        GeometryReader { geo in
            let maxX = geo.size.width - knob - 6
            ZStack(alignment: .leading) {
                Capsule().fill(tint.opacity(0.14))
                // fill grows as you drag
                Capsule().fill(tint.opacity(0.25))
                    .frame(width: offset + knob)
                Text(confirmed ? "Done!" : title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(tint)
                    .frame(maxWidth: .infinity)
                    .opacity(confirmed ? 1 : 1 - Double(offset / max(maxX, 1)))
                // the knob
                Circle().fill(tint)
                    .frame(width: knob, height: knob)
                    .overlay(Image(systemName: confirmed ? "checkmark" : "chevron.right")
                        .font(.system(size: 17, weight: .bold)).foregroundStyle(.white))
                    .offset(x: offset + 3)
                    .gesture(
                        DragGesture()
                            .onChanged { g in
                                guard !confirmed else { return }
                                offset = min(max(0, g.translation.width), maxX)
                            }
                            .onEnded { _ in
                                if offset >= maxX * 0.9 {
                                    withAnimation(.spring(response: 0.25)) { offset = maxX; confirmed = true }
                                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                                    onConfirm()
                                } else {
                                    withAnimation(.spring(response: 0.3)) { offset = 0 }
                                }
                            }
                    )
            }
        }
        .frame(height: knob + 6)
    }
}

/// The counter control: a big current/target readout with − and + steppers. Reaching the
/// target completes the habit (server enforces done = value >= target).
struct CounterControl: View {
    let habit: Habit
    var onChange: (Double) -> Void      // delta to apply

    var body: some View {
        VStack(spacing: 16) {
            Text(habit.progressLabel)
                .font(HabitTheme.serif(15, italic: true)).foregroundStyle(HabitTheme.inkSoft)
            HStack(spacing: 28) {
                stepper("minus", enabled: habit.progress > 0) { onChange(-1) }
                Text("\(Int(habit.progress))")
                    .font(HabitTheme.serif(56, weight: .bold))
                    .foregroundStyle(habit.isDoneToday ? HabitTheme.terracotta : HabitTheme.ink)
                    .frame(minWidth: 90)
                    .contentTransition(.numericText())
                stepper("plus", enabled: true) { onChange(1) }
            }
            goalBar
        }
    }
    private func stepper(_ icon: String, enabled: Bool, _ tap: @escaping () -> Void) -> some View {
        Button {
            tap(); UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } label: {
            Image(systemName: icon).font(.system(size: 20, weight: .bold))
                .foregroundStyle(enabled ? HabitTheme.terracotta : HabitTheme.inkSoft.opacity(0.4))
                .frame(width: 54, height: 54)
                .background(HabitTheme.card, in: Circle())
                .overlay(Circle().stroke(HabitTheme.line))
        }
        .buttonStyle(.plain).disabled(!enabled)
    }
    private var goalBar: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(HabitTheme.line)
                Capsule().fill(HabitTheme.terracotta).frame(width: geo.size.width * habit.goalFraction)
            }
        }
        .frame(height: 8)
    }
}

/// The timer control: a start/pause button ticking up toward the goal (minutes). Writes
/// elapsed minutes back to the server when paused/stopped or the goal is met.
struct TimerControl: View {
    let habit: Habit
    var onSetMinutes: (Double) -> Void

    @State private var running = false
    @State private var elapsed: TimeInterval = 0      // seconds this session
    @State private var startedAt: Date?
    @State private var baseMinutes: Double = 0        // already-logged minutes today
    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var totalMinutes: Double { baseMinutes + elapsed / 60 }
    private var fraction: Double { min(1, totalMinutes / habit.target) }

    var body: some View {
        VStack(spacing: 18) {
            ZStack {
                Circle().stroke(HabitTheme.line, lineWidth: 10)
                Circle().trim(from: 0, to: max(0.001, fraction))
                    .stroke(HabitTheme.terracotta, style: StrokeStyle(lineWidth: 10, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                VStack(spacing: 2) {
                    Text(clock).font(HabitTheme.serif(34, weight: .bold)).foregroundStyle(HabitTheme.ink)
                        .monospacedDigit()
                    Text("of \(Int(habit.target)) \(habit.unit ?? "min")")
                        .font(.system(size: 12)).foregroundStyle(HabitTheme.inkSoft)
                }
            }
            .frame(width: 180, height: 180)

            Button {
                running.toggle()
                if running { startedAt = Date() }
                else { commit() }
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            } label: {
                Label(running ? "Pause" : (totalMinutes > 0 ? "Resume" : "Start"),
                      systemImage: running ? "pause.fill" : "play.fill")
                    .font(.system(size: 16, weight: .semibold)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 14)
                    .background(HabitTheme.terracotta, in: Capsule())
            }
            .buttonStyle(.plain)
        }
        .onAppear { baseMinutes = habit.progress }
        .onReceive(tick) { _ in
            guard running, let s = startedAt else { return }
            elapsed = Date().timeIntervalSince(s)
            if totalMinutes >= habit.target { running = false; commit() }   // goal met
        }
        .onDisappear { if running { running = false }; commit() }
    }

    private var clock: String {
        let secs = Int(totalMinutes * 60)
        return String(format: "%d:%02d", secs / 60, secs % 60)
    }
    private func commit() {
        let mins = totalMinutes
        startedAt = nil; elapsed = 0; baseMinutes = mins
        onSetMinutes(mins)
    }
}
