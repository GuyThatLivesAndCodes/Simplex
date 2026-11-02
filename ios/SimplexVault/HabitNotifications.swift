import Foundation
import UserNotifications

/// Local reminders for habits. By default every habit reminds you DURING its time-of-day
/// period if it's still incomplete: one at the start of the period and one nudge near the
/// end. A per-habit `notify` flag (default on) turns them off for that habit.
///
/// Reminders are rescheduled from the current habit list whenever it changes, so a
/// completed habit stops nagging and an edited time updates. Because they repeat daily by
/// clock time, "incomplete" is enforced by clearing/rescheduling on each app load rather
/// than by the notification itself.
enum HabitNotifications {
    /// Period windows: (startHour, endHour). Used for the start + end-of-period nudges.
    static func window(_ slot: HabitSlot) -> (start: DateComponents, end: DateComponents) {
        switch slot {
        case .morning:   return (dc(8, 0),  dc(11, 30))
        case .afternoon: return (dc(13, 0), dc(16, 30))
        case .evening:   return (dc(19, 0), dc(21, 30))
        case .allday:    return (dc(9, 0),  dc(20, 0))
        }
    }
    private static func dc(_ h: Int, _ m: Int) -> DateComponents {
        var c = DateComponents(); c.hour = h; c.minute = m; return c
    }

    /// Ask for permission (call once, e.g. on first Habit visit).
    static func requestAuthorization() async {
        _ = try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound, .badge])
    }

    static func authorizationStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    /// A plain snapshot of the user's notification prefs, safe to read off the main actor
    /// inside the scheduling Task.
    struct Prefs { var enabled: Bool; var sound: UNNotificationSound?; var timeSensitive: Bool }

    /// Reschedule reminders for the whole active habit list. Clears everything we own and
    /// re-adds for habits with notify on that aren't archived. Safe to call often.
    /// @MainActor because it reads the user's HabitNotifPrefs (main-actor); all callers
    /// (HabitStore, HabitShell) are already on the main actor.
    @MainActor
    static func reschedule(_ habits: [Habit]) {
        // Read the user's chosen sound / time-sensitive / enabled prefs on the main actor,
        // then hand a plain snapshot to the background scheduling task.
        let p = HabitNotifPrefs.shared
        let prefs = Prefs(enabled: p.enabled, sound: p.sound.unSound, timeSensitive: p.timeSensitive)
        let center = UNUserNotificationCenter.current()
        Task {
            center.removeAllPendingNotificationRequests()
            // global off, or permission not granted → schedule nothing.
            guard prefs.enabled else { return }
            let status = await authorizationStatus()
            guard status == .authorized || status == .provisional else { return }
            for h in habits where !h.archived && h.notifyOn {
                schedule(h, prefs: prefs, in: center)
            }
        }
    }

    /// Remove reminders for a single habit (used when notify is turned off).
    static func cancel(_ habitId: String) {
        UNUserNotificationCenter.current()
            .removePendingNotificationRequests(withIdentifiers: ids(habitId))
    }

    // MARK: - internals

    private static func ids(_ habitId: String) -> [String] {
        ["habit.\(habitId).start", "habit.\(habitId).end"]
    }

    private static func schedule(_ h: Habit, prefs: Prefs, in center: UNUserNotificationCenter) {
        let win = window(h.slotEnum)

        // START reminder — use the habit's own reminder time if set, else the period start.
        var startComps = win.start
        if let r = h.reminder, let parsed = parse(r) { startComps = parsed }
        add(id: "habit.\(h.id).start", title: h.name,
            body: startBody(h), at: startComps, prefs: prefs, center: center)

        // END-OF-PERIOD nudge — a gentle "still time" reminder before the window closes.
        // (All-day gets just the single start reminder; a late all-day nudge is noise.)
        if h.slotEnum != .allday {
            add(id: "habit.\(h.id).end", title: h.name,
                body: "Still time to do this today.", at: win.end, prefs: prefs, center: center)
        }
    }

    private static func startBody(_ h: Habit) -> String {
        switch h.goal {
        case .check: return "A small thing for your \(periodWord(h.slotEnum))."
        case .count: return "Goal: \(Int(h.target)) \(h.unit ?? "times") today."
        case .timer: return "Goal: \(Int(h.target)) \(h.unit ?? "min") today."
        }
    }
    private static func periodWord(_ slot: HabitSlot) -> String {
        switch slot { case .morning: return "morning"; case .afternoon: return "afternoon"
        case .evening: return "evening"; case .allday: return "day" }
    }

    private static func add(id: String, title: String, body: String, at comps: DateComponents, prefs: Prefs, center: UNUserNotificationCenter) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = prefs.sound   // the user's chosen sound (nil = silent banner)
        // Time Sensitive breaks through Focus modes and shows prominently instead of being
        // buried under louder apps. If the app isn't granted the Time Sensitive entitlement
        // (e.g. sideloaded without it) iOS silently treats this as `.active` — no harm.
        content.interruptionLevel = prefs.timeSensitive ? .timeSensitive : .active
        content.relevanceScore = 1.0   // rank Simplex's reminder high in notification summaries
        var c = comps; c.second = 0
        let trigger = UNCalendarNotificationTrigger(dateMatching: c, repeats: true)   // daily
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
    }

    /// Parse "HH:mm" into hour/minute components.
    private static func parse(_ s: String) -> DateComponents? {
        let parts = s.split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]) else { return nil }
        return dc(h, m)
    }
}
