import SwiftUI

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
                HabitNotifSettingRow()
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

/// A read-only summary of notification status with a shortcut to Settings if disabled.
private struct HabitNotifSettingRow: View {
    @State private var status: String = "…"
    var body: some View {
        HStack {
            Label("Notifications", systemImage: "bell")
                .foregroundStyle(HabitTheme.ink)
            Spacer()
            Text(status).font(.system(size: 13)).foregroundStyle(HabitTheme.inkSoft)
        }
        .task {
            let s = await HabitNotifications.authorizationStatus()
            status = (s == .authorized || s == .provisional) ? "On" : "Off in Settings"
        }
        .onTapGesture {
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        }
    }
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
