import SwiftUI
import AVFoundation

@main
struct SimplexVaultApp: App {
    @StateObject private var store = Store()
    @ObservedObject private var appr = Appearance.shared

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
                .task { await store.bootstrap() }
                .preferredColorScheme(appr.colorScheme)   // follows the chosen theme
                .tint(appr.accent)
                // Privacy screen: blur + Face ID gate when the app leaves/returns to focus.
                .modifier(PrivacyScreen())
        }
    }
}

/// Routes between the loading splash, the login screen, and the signed-in vault.
struct RootView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        switch store.phase {
        case .loading:
            LoadingView()
        case .signedOut:
            LoginView()
        case .signedIn:
            VaultView()
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
