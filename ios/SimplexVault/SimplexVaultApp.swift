import SwiftUI
import AVFoundation

@main
struct SimplexVaultApp: App {
    @StateObject private var store = Store()
    @StateObject private var router = SystemRouter()

    init() {
        // Playback audio session: lets video/audio play (incl. in silent mode) and
        // route to AirPlay devices (casting to a TV).
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback, options: [.allowAirPlay])
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(router)
                .task { await store.bootstrap() }
                // Privacy screen: blur + Face ID gate when the app leaves/returns to focus.
                .modifier(PrivacyScreen())
        }
    }
}

/// Routes between the loading splash, the login screen, and the signed-in app shell.
/// (Color scheme / tint are set per-system inside AppShell, since Habit uses its own
/// warm theme while Database follows the user's chosen appearance.)
struct RootView: View {
    @EnvironmentObject var store: Store
    @ObservedObject private var appr = Appearance.shared

    var body: some View {
        switch store.phase {
        case .loading:
            LoadingView().preferredColorScheme(appr.colorScheme).tint(appr.accent)
        case .signedOut:
            LoginView().preferredColorScheme(appr.colorScheme).tint(appr.accent)
        case .signedIn:
            AppShell()
        }
    }
}

struct LoadingView: View {
    var body: some View {
        ZStack {
            SimplexTheme.bg.ignoresSafeArea()
            VStack(spacing: 16) {
                SimplexMark()
                ProgressView().tint(SimplexTheme.accent)
            }
        }
    }
}
