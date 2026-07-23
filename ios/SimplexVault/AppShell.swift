import SwiftUI

/// The signed-in root. Hosts the ACTIVE system's tab shell, applies that system's theme,
/// and presents the system switcher. Account is shared across systems; the other tabs
/// swap per system.
struct AppShell: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var router: SystemRouter
    @ObservedObject private var appr = Appearance.shared
    // Owned HERE (not inside HabitShell) so switching systems and coming back doesn't
    // destroy + recreate the store — which made habits briefly vanish and could pop
    // onboarding on return. It stays loaded for the life of the session.
    @StateObject private var habitStore = HabitStore()
    // Owned HERE too so training keeps running across system switches and models don't
    // reload (mirrors the habitStore decision).
    @StateObject private var neuralStore = NeuralStore()

    var body: some View {
        Group {
            switch router.active {
            case .database:
                DatabaseShell()
            case .habit:
                HabitShell()
            case .neural:
                NeuralShell()
            }
        }
        // Every system follows the app's chosen appearance (dark/light + accent), so the
        // whole app reads as one product with no outlier screens.
        .preferredColorScheme(appr.colorScheme)
        .tint(appr.accent)
        .environmentObject(habitStore)
        .environmentObject(neuralStore)
        .sheet(isPresented: $router.showSwitcher) { SystemSwitcher() }
    }
}

/// The Database system: the vault tabs (Files / Recents / Search) + Account, each a nav
/// stack. A system-switcher button sits at the top-left of each tab.
struct DatabaseShell: View {
    @EnvironmentObject var store: Store
    @State private var tab = 0

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack { FolderView(folder: nil, title: "Files").withSystemSwitcher() }
                .tabItem { Label("Files", systemImage: "folder") }.tag(0)
            NavigationStack { RecentsView().withSystemSwitcher() }
                .tabItem { Label("Recents", systemImage: "clock") }.tag(1)
            NavigationStack { SearchView().withSystemSwitcher() }
                .tabItem { Label("Search", systemImage: "magnifyingglass") }.tag(2)
            NavigationStack { AccountView() }
                .tabItem { Label("Account", systemImage: "person") }.tag(3)
        }
        .tint(SimplexTheme.accent)
        .overlay(alignment: .bottom) { UploadTray().padding(.bottom, 52) }
        .sheet(isPresented: $store.showTosSheet) {
            TosSheet { accepted in await store.resolveTos(accepted: accepted) }
                .interactiveDismissDisabled()
        }
    }
}

/// Adds the top-left system-switcher button to a screen's toolbar.
struct SystemSwitcherButton: ViewModifier {
    @EnvironmentObject var router: SystemRouter
    func body(content: Content) -> some View {
        content.toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { router.showSwitcher = true } label: {
                    // the little "h"/grid mark that opens the systems grid
                    Image(systemName: "square.grid.2x2.fill")
                        .font(.system(size: 15, weight: .semibold))
                }
                .accessibilityLabel("Switch system")
            }
        }
    }
}
extension View {
    func withSystemSwitcher() -> some View { modifier(SystemSwitcherButton()) }
}

/// The grid of available systems (Database, Habit for now). Tapping one switches the
/// whole app to it.
struct SystemSwitcher: View {
    @EnvironmentObject var router: SystemRouter
    @Environment(\.dismiss) private var dismiss

    private let cols = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]

    var body: some View {
        NavigationStack {
            ZStack {
                SimplexTheme.bg.ignoresSafeArea()
                VStack(alignment: .leading, spacing: 6) {
                    Text("SIMPLEX")
                        .font(SimplexTheme.mono(12, weight: .semibold)).tracking(3)
                        .foregroundStyle(SimplexTheme.subtle)
                        .padding(.horizontal, 20).padding(.top, 8)
                    Text("Systems")
                        .font(.system(size: 30, weight: .bold))
                        .foregroundStyle(SimplexTheme.text)
                        .padding(.horizontal, 20)

                    LazyVGrid(columns: cols, spacing: 14) {
                        ForEach(SystemRouter.System.allCases) { sys in
                            Button { router.switchTo(sys) } label: { SystemTile(system: sys, active: sys == router.active) }
                                .buttonStyle(.plain)
                        }
                    }
                    .padding(20)
                    Spacer()
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Close") { dismiss() } }
            }
        }
        .preferredColorScheme(Appearance.shared.colorScheme)
        .tint(SimplexTheme.accent)
    }
}

private struct SystemTile: View {
    let system: SystemRouter.System
    let active: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 12).fill(system.tint.opacity(0.16))
                Image(systemName: system.icon).font(.system(size: 26)).foregroundStyle(system.tint)
            }
            .frame(height: 76)
            Text(system.title).font(.system(size: 16, weight: .semibold)).foregroundStyle(SimplexTheme.text)
            Text(system.subtitle).font(SimplexTheme.mono(10)).foregroundStyle(SimplexTheme.subtle).lineLimit(1)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SimplexTheme.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(active ? system.tint : SimplexTheme.line, lineWidth: active ? 2 : 1))
    }
}
