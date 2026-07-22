import SwiftUI

@main
struct SimplexVaultApp: App {
    @StateObject private var store = Store()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .task { await store.bootstrap() }
                .preferredColorScheme(.dark)   // matches the Simplex dark theme
                .tint(SimplexTheme.accent)
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
