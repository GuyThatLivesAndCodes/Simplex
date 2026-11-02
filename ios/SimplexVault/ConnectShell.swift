import SwiftUI

/// The Connect system's shell. Connect is a single-purpose system — rooms and the
/// account — so it uses a two-tab layout rather than the deeper Database/Habit ones.
struct ConnectShell: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var connect: ConnectStore
    @State private var tab = 0

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack { ConnectRoomsView().withSystemSwitcher() }
                .tabItem { Label("Rooms", systemImage: "video.bubble") }.tag(0)
            // the shared account page (identity / storage / Face ID / sign out) —
            // NOT HabitAccountView, which is habit-scoped and habit-themed
            NavigationStack { AccountView() }
                .tabItem { Label("Account", systemImage: "person") }.tag(1)
        }
        .task {
            // The store needs our account id to tell our own messages/reactions apart
            // from everyone else's (broadcast payloads carry no per-viewer flags).
            connect.myAccountId = store.account?.id
            if !connect.loaded { await connect.loadRooms() }
        }
        .onChange(of: store.account?.id) { newValue in
            connect.myAccountId = newValue
        }
    }
}
