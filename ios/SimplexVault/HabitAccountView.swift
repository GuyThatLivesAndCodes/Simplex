import SwiftUI
import UserNotifications

/// The Habit system's own Account page — habit-scoped only. Appearance and the main
/// account (identity, storage, Face ID, sign out) live in the Database/Vault account, not
/// here. This page is about the user's HABIT account: backups, archived habits, and
/// habit-wide settings.
struct HabitAccountView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var habits: HabitStore

    var body: some View {
        List {
            // identity (habit member)
            Section {
                HStack(spacing: 14) {
                    Text("h").font(HabitTheme.serif(20, italic: true)).foregroundStyle(.white)
                        .frame(width: 46, height: 46).background(HabitTheme.terracotta, in: RoundedRectangle(cornerRadius: 12))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(store.account?.display ?? store.account?.username ?? "You")
                            .font(HabitTheme.serif(18, weight: .semibold)).foregroundStyle(HabitTheme.ink)
                        Text("\(habits.activeHabits.count) habits · saved on this phone")
                            .font(.system(size: 12)).foregroundStyle(HabitTheme.inkSoft)
                    }
                }
            }
            .listRowBackground(HabitTheme.card)

            // backups
            Section {
                NavigationLink { HabitBackupsView() } label: {
                    Label("Backups & restore", systemImage: "clock.arrow.circlepath")
                }
            } header: {
                Text("Data")
            } footer: {
                Text("Your habits live on this phone and work offline. A backup is saved to your account each day so you can restore or move to a new device.")
            }
            .listRowBackground(HabitTheme.card)

            // archived
            if !habits.archivedHabits.isEmpty {
                Section("Archived") {
                    ForEach(habits.archivedHabits) { h in
                        HStack {
                            Image(systemName: habitIcon(h.icon)).foregroundStyle(HabitTheme.inkSoft)
                            Text(h.name).foregroundStyle(HabitTheme.ink)
                            Spacer()
                            Button("Restore") { habits.archive(h, false) }
                                .font(.system(size: 13)).foregroundStyle(HabitTheme.terracotta)
                        }
                    }
                }
                .listRowBackground(HabitTheme.card)
            }

            // habit settings
            Section("Reminders") {
                NavigationLink { HabitNotifSettingsView().environmentObject(habits) } label: {
                    HabitNotifSummaryRow()
                }
            }
            .listRowBackground(HabitTheme.card)

            Section {
                Text("Appearance and your main account are in the Database system.")
                    .font(.system(size: 12)).foregroundStyle(HabitTheme.inkSoft)
            }
            .listRowBackground(Color.clear)
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(HabitTheme.cream)
        .navigationTitle("Habit account")
        .navigationBarTitleDisplayMode(.large)
    }
}

/// Compact summary row shown in the account list (taps into the full settings screen).
private struct HabitNotifSummaryRow: View {
    @ObservedObject private var prefs = HabitNotifPrefs.shared
    var body: some View {
        HStack {
            Label("Notifications", systemImage: "bell.badge").foregroundStyle(HabitTheme.ink)
            Spacer()
            Text(prefs.enabled ? "\(prefs.sound.name)" : "Off")
                .font(.system(size: 13)).foregroundStyle(HabitTheme.inkSoft)
        }
    }
}

/// Full notification settings: master enable, sound picker (with preview), time-sensitive
/// delivery, and a system-permission shortcut. Changes reschedule pending reminders.
struct HabitNotifSettingsView: View {
    @EnvironmentObject var habits: HabitStore
    @ObservedObject private var prefs = HabitNotifPrefs.shared
    @State private var systemStatus: UNAuthorizationStatus = .notDetermined

    var body: some View {
        List {
            // permission banner if the OS has notifications disabled for the app
            if systemStatus != .authorized && systemStatus != .provisional {
                Section {
                    Button {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Notifications are off in iOS Settings").font(.system(size: 14, weight: .medium)).foregroundStyle(HabitTheme.ink)
                                Text("Tap to enable them for Simplex — otherwise reminders can't be delivered.")
                                    .font(.system(size: 12)).foregroundStyle(HabitTheme.inkSoft)
                            }
                        }
                    }
                }
                .listRowBackground(HabitTheme.card)
            }

            // master enable
            Section {
                Toggle(isOn: Binding(get: { prefs.enabled }, set: { prefs.enabled = $0; reschedule() })) {
                    Label("Reminder notifications", systemImage: "bell").foregroundStyle(HabitTheme.ink)
                }.tint(HabitTheme.terracotta)
            } footer: {
                Text("Get a push when a habit's time-of-day period starts (and a gentle nudge before it ends) if it's still not done.")
            }
            .listRowBackground(HabitTheme.card)

            // sound picker
            Section {
                ForEach(NotifSound.all) { s in
                    Button {
                        prefs.soundId = s.id
                        NotifSound.preview(s)   // hear it immediately
                        reschedule()
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: s.symbol).frame(width: 22).foregroundStyle(HabitTheme.terracotta)
                            Text(s.name).foregroundStyle(HabitTheme.ink)
                            Spacer()
                            if s.id != "silent" {
                                Button { NotifSound.preview(s) } label: { Image(systemName: "play.circle").foregroundStyle(HabitTheme.inkSoft) }
                                    .buttonStyle(.plain)
                            }
                            if prefs.soundId == s.id { Image(systemName: "checkmark").foregroundStyle(HabitTheme.terracotta) }
                        }
                    }
                    .disabled(!prefs.enabled)
                    .opacity(prefs.enabled ? 1 : 0.5)
                }
            } header: {
                Text("Sound")
            } footer: {
                Text("Pick a distinctive sound so Simplex reminders stand out. Tap any to preview.")
            }
            .listRowBackground(HabitTheme.card)

            // time sensitive
            Section {
                Toggle(isOn: Binding(get: { prefs.timeSensitive }, set: { prefs.timeSensitive = $0; reschedule() })) {
                    Label("Time Sensitive", systemImage: "clock.badge.exclamationmark").foregroundStyle(HabitTheme.ink)
                }.tint(HabitTheme.terracotta).disabled(!prefs.enabled)
            } footer: {
                Text("Delivers reminders as Time Sensitive so they break through Focus modes and appear near the top — above quieter apps. Requires notification permission; if your build wasn't granted the Time Sensitive capability, they're delivered normally instead.")
            }
            .listRowBackground(HabitTheme.card)
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(HabitTheme.cream)
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await HabitNotifications.requestAuthorization()
            systemStatus = await HabitNotifications.authorizationStatus()
        }
    }

    private func reschedule() { HabitNotifications.reschedule(habits.habits) }
}

/// Backups list — pick a day and restore (overwriting the phone), or back up now.
struct HabitBackupsView: View {
    @EnvironmentObject var habits: HabitStore
    @State private var backups: [API.HabitBackupMeta] = []
    @State private var loading = true
    @State private var restoring: String?
    @State private var confirmDay: String?
    @State private var message: String?

    var body: some View {
        List {
            Section {
                Button {
                    Task { await habits.backupNow(); await reload(); message = "Backed up." }
                } label: {
                    Label("Back up now", systemImage: "arrow.up.circle")
                }
                if let message { Text(message).font(.system(size: 12)).foregroundStyle(HabitTheme.inkSoft) }
            }
            .listRowBackground(HabitTheme.card)

            Section("Restore a day") {
                if loading {
                    HStack { Spacer(); ProgressView(); Spacer() }
                } else if backups.isEmpty {
                    Text("No backups yet.").foregroundStyle(HabitTheme.inkSoft)
                } else {
                    ForEach(backups) { b in
                        Button { confirmDay = b.day } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(prettyDay(b.day)).foregroundStyle(HabitTheme.ink)
                                    Text("\(b.habitCount) habits · \(relativeDate(b.updated))")
                                        .font(.system(size: 12)).foregroundStyle(HabitTheme.inkSoft)
                                }
                                Spacer()
                                if restoring == b.day { ProgressView() }
                                else { Image(systemName: "arrow.uturn.backward").foregroundStyle(HabitTheme.terracotta) }
                            }
                        }
                    }
                }
            }
            .listRowBackground(HabitTheme.card)
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(HabitTheme.cream)
        .navigationTitle("Backups")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .alert("Restore this day?", isPresented: Binding(get: { confirmDay != nil }, set: { if !$0 { confirmDay = nil } })) {
            Button("Restore", role: .destructive) { if let d = confirmDay { restore(d) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This replaces your current habits and progress on this phone with the backup from \(confirmDay.map(prettyDay) ?? "that day"). This can't be undone.")
        }
    }

    private func reload() async {
        loading = true
        backups = (try? await API.shared.listHabitBackups()) ?? []
        loading = false
    }
    private func restore(_ day: String) {
        restoring = day
        Task {
            if let doc = try? await API.shared.getHabitBackup(day: day) {
                habits.restore(doc)
                message = "Restored \(prettyDay(day))."
            } else {
                message = "Couldn't load that backup."
            }
            restoring = nil
        }
    }
    private func prettyDay(_ s: String) -> String {
        guard let d = HabitDay.date(s) else { return s }
        let f = DateFormatter(); f.dateStyle = .medium
        return f.string(from: d)
    }
}
